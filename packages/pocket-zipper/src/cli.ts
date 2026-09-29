#!/usr/bin/env node
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluate } from "./pipeline.js";
import { renderReport } from "./report.js";
import { runValidate } from "./validate-command.js";
import { runExceptionAdd } from "./wizard.js";
import type { Mode } from "./types.js";

/** The evaluation commands write a JSON record; `validate` prints diagnostics; `exception add` runs the wizard. */
type Command = Mode | "validate" | "exception add";

/**
 * The flags each command reads. `validate` reads none: it is a working-tree
 * lint with no evaluation record to write and no strictness to dial, so an
 * unlisted flag is an unknown argument rather than a silently ignored one. The
 * table is also the command list, so a command and its flags are declared once.
 */
const FLAGS: Record<Command, readonly string[]> = {
  check: ["--base", "--json", "--verbose"],
  "pre-commit": ["--json", "--verbose"],
  validate: [],
  "exception add": ["--from", "--reason", "--reference"],
};

function isCommand(arg: string | undefined): arg is Command {
  return arg !== undefined && arg in FLAGS;
}

interface Args {
  command: Command;
  baseRef: string;
  jsonPath: string | null;
  verbose: boolean;
  /** `exception add` only: the non-interactive selector and answers. */
  from: string | null;
  reason: string | null;
  reference: string | null;
}

function parseArgs(argv: string[]): Args | { error: string } | { help: true } {
  const first = argv[0];
  if (first === "--help" || first === "-h" || first === undefined) {
    return { help: true };
  }
  // `exception add` is the one two-word command; everything else is one word.
  const command: Command | undefined =
    first === "exception" && argv[1] === "add"
      ? "exception add"
      : isCommand(first)
        ? first
        : undefined;
  if (command === undefined) {
    return { error: usage() };
  }
  const rest = command === "exception add" ? argv.slice(2) : argv.slice(1);
  const flags = FLAGS[command];
  let baseRef = "";
  let jsonPath: string | null = null;
  let verbose = false;
  let from: string | null = null;
  let reason: string | null = null;
  let reference: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--help" || arg === "-h") {
      return { error: usage() };
    }
    if (!flags.includes(arg)) {
      return { error: `unknown argument '${arg}'\n` + usage() };
    }
    // Past the membership test, every accepted flag is read here: the table
    // decides which flags a command accepts, this decides what they do.
    if (arg === "--base") {
      baseRef = rest[++i] ?? "";
      if (!baseRef) return { error: "check requires --base <ref>\n" + usage() };
    } else if (arg === "--json") {
      jsonPath = rest[++i] ?? "";
      if (!jsonPath) return { error: "--json requires a path\n" + usage() };
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--from") {
      from = rest[++i] ?? "";
      if (!from) return { error: "--from requires <file:line>\n" + usage() };
    } else if (arg === "--reason") {
      reason = rest[++i] ?? "";
      if (!reason) return { error: "--reason requires <text>\n" + usage() };
    } else if (arg === "--reference") {
      reference = rest[++i] ?? "";
      if (!reference) return { error: "--reference requires <link>\n" + usage() };
    }
  }
  if (command === "check" && !baseRef) {
    return { error: "check requires --base <ref>\n" + usage() };
  }
  // The wizard's flags travel together: `--from` selects the suppression,
  // `--reason` and `--reference` answer the interview it selects for.
  if (command === "exception add" && (reason !== null || reference !== null) && from === null) {
    return { error: "--reason and --reference require --from <file:line>\n" + usage() };
  }
  return { command, baseRef, jsonPath, verbose, from, reason, reference };
}

function usage(): string {
  return [
    "Usage:",
    "  pocket-zipper check --base <ref> [--json <path>] [--verbose]",
    "  pocket-zipper pre-commit [--json <path>] [--verbose]",
    "  pocket-zipper validate",
    "  pocket-zipper exception add [--from <file:line> --reason <text> --reference <link>]",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(parsed.error + "\n");
    return 2;
  }

  // `validate` reports findings as diagnostic lines and has no evaluation
  // record to write: it is a working-tree lint, not a comparison of two trees.
  if (parsed.command === "validate") {
    const result = await runValidate({ cwd: process.cwd(), now: new Date() });
    process.stdout.write(result.report);
    return result.exitCode;
  }

  // `exception add` runs the authoring wizard: prompts on stdin, transcript on
  // stdout, and no evaluation record — its write is a proposal to the working
  // tree, never a verdict.
  if (parsed.command === "exception add") {
    const result = await runExceptionAdd({
      cwd: process.cwd(),
      now: new Date(),
      ...(parsed.from === null ? {} : { from: parsed.from }),
      ...(parsed.reason === null ? {} : { reason: parsed.reason }),
      ...(parsed.reference === null ? {} : { reference: parsed.reference }),
      input: process.stdin,
      output: process.stdout,
      stderr: process.stderr,
    });
    return result.exitCode;
  }

  const result = await evaluate({
    mode: parsed.command,
    cwd: process.cwd(),
    baseRef: parsed.baseRef,
    now: new Date(),
  });

  if (parsed.jsonPath) {
    writeFileSync(parsed.jsonPath, JSON.stringify(result.record, null, 2) + "\n", "utf8");
  }

  const report = renderReport(result.record, {
    verbose: parsed.verbose,
    tty: process.stdout.isTTY === true,
    suggestedExpiry: result.suggestedExpiry,
    maxExpiry: result.maxExpiry,
  });
  if (report.length > 0) process.stdout.write(report);
  return result.exitCode;
}

function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

// Compare resolved paths: an installed binary is often invoked through a
// symlinked path — npm bin shims, a symlinked install directory, or OS
// temp-dir symlinks such as macOS `/tmp` and `/var` — which would otherwise
// make the entry check fail and exit silently.
const invokedDirectly =
  process.argv[1] !== undefined &&
  sameRealPath(fileURLToPath(import.meta.url), process.argv[1]);

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`pocket-zipper: internal error: ${String(err)}\n`);
      process.exitCode = 2;
    });
}
