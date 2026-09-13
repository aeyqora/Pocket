#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluate } from "./pipeline.js";
import { renderReport } from "./report.js";
import type { Mode } from "./types.js";

interface Args {
  mode: Mode;
  baseRef: string;
  jsonPath: string | null;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args | { error: string } | { help: true } {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    return { help: true };
  }
  if (command !== "check" && command !== "pre-commit") {
    return { error: usage() };
  }
  let baseRef = "";
  let jsonPath: string | null = null;
  let verbose = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--base") {
      baseRef = rest[++i] ?? "";
      if (!baseRef) return { error: "check requires --base <ref>\n" + usage() };
    } else if (arg === "--json") {
      jsonPath = rest[++i] ?? "";
      if (!jsonPath) return { error: "--json requires a path\n" + usage() };
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      return { error: usage() };
    } else {
      return { error: `unknown argument '${arg}'\n` + usage() };
    }
  }
  if (command === "check" && !baseRef) {
    return { error: "check requires --base <ref>\n" + usage() };
  }
  return { mode: command, baseRef, jsonPath, verbose };
}

function usage(): string {
  return [
    "Usage:",
    "  pocket-lock check --base <ref> [--json <path>] [--verbose]",
    "  pocket-lock pre-commit [--json <path>] [--verbose]",
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

  const result = await evaluate({
    mode: parsed.mode,
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
  });
  if (report.length > 0) process.stdout.write(report);
  return result.exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`pocket-lock: internal error: ${String(err)}\n`);
      process.exitCode = 2;
    });
}
