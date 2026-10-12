import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, type ParsedInvocation, type ParseError } from "../src/args.js";

function invocation(argv: string[]): ParsedInvocation {
  const result = parseArgs(argv);
  assert.equal(result.kind, "invocation", `expected invocation, got ${JSON.stringify(result)}`);
  return result as ParsedInvocation;
}

function failure(argv: string[]): ParseError {
  const result = parseArgs(argv);
  assert.equal(result.kind, "error", `expected error, got ${JSON.stringify(result)}`);
  return result as ParseError;
}

test("every action verb parses", () => {
  for (const action of ["suppress", "fix", "remove", "replace", "cleanup", "inventory"] as const) {
    assert.equal(invocation([action]).action, action);
  }
});

test("the full suppress flag set parses", () => {
  const parsed = invocation([
    "suppress",
    "-c",
    "comb.config.mjs",
    "-t",
    "src",
    "--dry-run",
    "--reason",
    "legacy app",
    "--fix-first",
    "--reuse-blocks",
    "--format",
    "json",
    "--out",
    "-",
    "--workers",
    "4",
    "--batch-size",
    "8",
    "--extensions",
    ".ts, .tsx",
  ]);
  assert.deepEqual(parsed, {
    kind: "invocation",
    action: "suppress",
    help: false,
    version: false,
    config: "comb.config.mjs",
    target: "src",
    mode: "dry-run",
    from: null,
    to: null,
    reason: "legacy app",
    fixFirst: true,
    reuseBlocks: true,
    format: "json",
    out: "-",
    noReport: false,
    workers: 4,
    serial: false,
    batchSize: 8,
    extensions: [".ts", ".tsx"],
  });
});

test("--apply selects apply mode", () => {
  assert.equal(invocation(["fix", "--apply"]).mode, "apply");
});

test("--serial and --no-report are booleans", () => {
  const parsed = invocation(["cleanup", "--serial", "--no-report"]);
  assert.equal(parsed.serial, true);
  assert.equal(parsed.noReport, true);
});

test("replace reads the rename pair", () => {
  const parsed = invocation(["replace", "--from", "a", "--to", "b"]);
  assert.equal(parsed.from, "a");
  assert.equal(parsed.to, "b");
});

test("--flag=value form is accepted", () => {
  const parsed = invocation(["inventory", "--config=comb.json", "--format=csv"]);
  assert.equal(parsed.config, "comb.json");
  assert.equal(parsed.format, "csv");
});

test("--help with no action is not an error", () => {
  const parsed = invocation(["--help"]);
  assert.equal(parsed.help, true);
  assert.equal(parsed.action, null);
});

test("--help after an action keeps the action", () => {
  const parsed = invocation(["suppress", "--help"]);
  assert.equal(parsed.help, true);
  assert.equal(parsed.action, "suppress");
});

test("--version is not an error", () => {
  const parsed = invocation(["--version"]);
  assert.equal(parsed.version, true);
  assert.equal(parsed.action, null);
});

test("an unknown verb is an error", () => {
  assert.match(failure(["bogus"]).message, /bogus/);
});

test("an unknown flag is an error", () => {
  assert.match(failure(["suppress", "--nope"]).message, /--nope/);
});

test("an unexpected positional argument is an error", () => {
  assert.match(failure(["suppress", "extra"]).message, /extra/);
});

test("a value flag with no value is an error", () => {
  assert.match(failure(["suppress", "--config"]).message, /--config/);
});

test("an invalid --format is an error", () => {
  assert.match(failure(["suppress", "--format", "yaml"]).message, /yaml/);
});

test("--workers must be a positive integer", () => {
  assert.match(failure(["suppress", "--workers", "0"]).message, /workers/);
  assert.match(failure(["suppress", "--workers", "abc"]).message, /workers/);
});

test("--batch-size must be a positive integer", () => {
  assert.match(failure(["suppress", "--batch-size", "-1"]).message, /batch-size/);
});

test("--dry-run and --apply are mutually exclusive", () => {
  assert.match(failure(["suppress", "--dry-run", "--apply"]).message, /dry-run/);
});

test("an action-specific flag on the wrong action is an error", () => {
  assert.match(failure(["suppress", "--from", "a", "--to", "b"]).message, /--from/);
  assert.match(failure(["fix", "--reason", "x"]).message, /--reason/);
  assert.match(failure(["fix", "--reuse-blocks"]).message, /--reuse-blocks/);
  assert.match(failure(["inventory", "--apply"]).message, /--apply/);
});

test("--from and --to must be given together", () => {
  assert.match(failure(["replace", "--from", "a"]).message, /--to/);
  assert.match(failure(["replace", "--to", "b"]).message, /--from/);
});
