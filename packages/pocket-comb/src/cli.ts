#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, usage } from "./args.js";
import { runAction } from "./actions/index.js";
import { loadConfig } from "./config.js";
import { isOperationalError } from "./errors.js";
import { ACTIONS } from "./types.js";
import { VERSION } from "./version.js";
import { createClackPrompter, runWizard } from "./wizard.js";
import type { ParsedInvocation } from "./args.js";
import type { LoadedConfig } from "./config.js";
import type { Action } from "./types.js";
import type { Prompter } from "./wizard.js";

/**
 * Where a command reads and writes, and whether it may prompt. Injected rather
 * than reached for globally so the non-TTY strictness branch — the one that must
 * never prompt a pipe — is observable from a test at all.
 */
export interface CommandIo {
  cwd: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /**
   * True when prompting is allowed. A run whose stdin is not a terminal has
   * nobody to answer: anything required and missing is exit 2 listing exactly
   * the missing flags, never a question.
   */
  tty: boolean;
}

export function processIo(): CommandIo {
  return {
    cwd: process.cwd(),
    input: process.stdin,
    output: process.stdout,
    stderr: process.stderr,
    tty: (process.stdin as { isTTY?: boolean }).isTTY === true,
  };
}

/** Injectable dependencies for `main`; the wizard's prompts default to clack. */
export interface MainDeps {
  /** The wizard's prompt primitives. Tests inject a fake to avoid a real TTY. */
  prompter?: Prompter;
}

/**
 * The flags a non-interactive run must carry, given what the config already
 * answers. Config itself is not listed here: a missing or unloadable config is
 * its own precise operational error from `loadConfig`. `--target` has a cwd
 * default and `--reason` is optional, so neither is ever "missing".
 */
function missingRequiredFlags(
  parsed: ParsedInvocation,
  config: LoadedConfig,
  tty: boolean,
): string[] {
  if (tty) return [];
  const missing: string[] = [];
  if (parsed.action === "replace") {
    const carried = config.replace !== undefined || (parsed.from !== null && parsed.to !== null);
    if (!carried) {
      if (parsed.from === null) missing.push("--from");
      if (parsed.to === null) missing.push("--to");
    }
  }
  return missing;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  io: CommandIo = processIo(),
  deps: MainDeps = {},
): Promise<number> {
  try {
    const parsed = parseArgs(argv);

    if (parsed.kind === "error") {
      io.stderr.write(parsed.message + "\n");
      return 2;
    }
    if (parsed.version) {
      io.output.write(`${VERSION}\n`);
      return 0;
    }

    // The interactive session (spec §5): entered only on a TTY. It fills the gaps
    // flags and settings leave, runs the chosen action, and offers apply/restart/
    // abort after a dry run. A non-TTY run never reaches it.
    const runTtyWizard = (): Promise<number> =>
      runWizard({
        parsed,
        io,
        cwd: io.cwd,
        prompter: deps.prompter ?? createClackPrompter(io),
        loadConfig,
        run: async ({ parsed: resolved, config }) => {
          if (resolved.action === null) {
            // The wizard always resolves an action before running.
            throw new Error("wizard finished without an action");
          }
          return runAction(resolved.action as Action, { parsed: resolved, config, io });
        },
      });

    if (parsed.action === null) {
      if (parsed.help) {
        io.output.write(usage(null) + "\n");
        return 0;
      }
      if (io.tty) return await runTtyWizard();
      io.stderr.write(
        `pocket-comb: missing action (one of ${ACTIONS.join(", ")})\n${usage(null)}\n`,
      );
      return 2;
    }
    if (parsed.help) {
      io.output.write(usage(parsed.action) + "\n");
      return 0;
    }

    if (io.tty) return await runTtyWizard();

    const config = await loadConfig({
      ...(parsed.config !== null ? { configFlag: parsed.config } : {}),
      ...(parsed.target !== null ? { targetFlag: parsed.target } : {}),
      ...(parsed.from !== null && parsed.to !== null
        ? { replaceFlag: { from: parsed.from, to: parsed.to } }
        : {}),
      ...(parsed.format !== null && parsed.out !== null
        ? { reportFlag: { format: parsed.format, out: parsed.out } }
        : {}),
      cwd: io.cwd,
    });

    const missing = missingRequiredFlags(parsed, config, io.tty);
    if (missing.length > 0) {
      const label = missing.length === 1 ? "flag" : "flags";
      io.stderr.write(`pocket-comb: missing required ${label}: ${missing.join(", ")}\n`);
      return 2;
    }

    // Dispatch the validated invocation. Each action command lives in
    // `actions/<verb>.ts` and is registered in `actions/index.ts`; the command
    // returns its exit code (0 success, 1 dry-run impact) and any operational
    // failure throws for the handler below to map to 2.
    return await runAction(parsed.action, { parsed, config, io });
  } catch (err) {
    if (isOperationalError(err)) {
      io.stderr.write(`pocket-comb: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

// An installed binary is often invoked through a symlinked path (npm bin shims,
// a symlinked install directory, macOS temp-dir symlinks); compare real paths so
// the entry check does not fail and exit silently.
const invokedDirectly =
  process.argv[1] !== undefined &&
  sameRealPath(fileURLToPath(import.meta.url), process.argv[1]);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`pocket-comb: internal error: ${String(err)}\n`);
      process.exitCode = 2;
    });
}
