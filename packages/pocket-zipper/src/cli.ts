#!/usr/bin/env node
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluate } from "./pipeline.js";
import { renderReport } from "./report.js";
import { runValidate } from "./validate-command.js";
import type { Mode } from "./types.js";

/** The evaluation commands write a JSON record; `validate` prints diagnostics. */
type Command = Mode | "validate";

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
};

function isCommand(arg: string | undefined): arg is Command {
  return arg !== undefined && arg in FLAGS;
}

interface Args {
  command: Command;
  baseRef: string;
  jsonPath: string | null;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args | { error: string } | { help: true } {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    return { help: true };
  }
  if (!isCommand(command)) {
    return { error: usage() };
  }
  const flags = FLAGS[command];
  let baseRef = "";
  let jsonPath: string | null = null;
  let verbose = false;
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
    }
  }
  if (command === "check" && !baseRef) {
    return { error: "check requires --base <ref>\n" + usage() };
  }
  return { command, baseRef, jsonPath, verbose };
}

function usage(): string {
  return [
    "Usage:",
    "  pocket-zipper check --base <ref> [--json <path>] [--verbose]",
    "  pocket-zipper pre-commit [--json <path>] [--verbose]",
    "  pocket-zipper validate",
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
