import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createIsolatedESLint } from "../src/eslint.js";
import { runActionForFile, runBatch } from "../src/engine.js";
import { cleanupTemps, tempDir, write } from "./harness.js";
import type { LineSyntaxResolver } from "../src/syntax.js";
import type { LintMessage } from "../src/types.js";

after(cleanupTemps);

const codeSyntax: LineSyntaxResolver = () => ({ context: "js" });

const CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-debugger": "warn", "no-unused-vars": "error" } },
];
`;

function message(severity: 1 | 2, rule: string, line: number): LintMessage {
  return {
    ruleId: rule,
    severity,
    message: "boom",
    line,
    column: 1,
  } as LintMessage;
}

test("the suppress strategy inserts an indent-matched guard and ledgers the edit", () => {
  const result = runActionForFile({
    action: "suppress",
    params: {},
    filePath: "/tmp/x.js",
    text: "function f() {\n  debugger;\n}\n",
    messages: [message(1, "no-debugger", 2)],
    syntax: codeSyntax,
  });

  assert.equal(result.output, "function f() {\n  // eslint-disable-next-line no-debugger\n  debugger;\n}\n");
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0]?.rule, "no-debugger");
  assert.equal(result.edits[0]?.editType, "insert");
  assert.equal(result.edits[0]?.form, "next-line");
  assert.deepEqual(result.stats, {
    inserted: 1,
    prepended: 0,
    skippedBare: 0,
    skippedGuarded: 0,
    skippedContext: 0,
  });
});

test("runBatch lints a batch and plans inserts without writing on a dry run", async () => {
  const dir = tempDir();
  const target = join(dir, "target");
  const dirty = write(dir, "target/dirty.js", "debugger;\ndebugger;\n");
  const clean = write(dir, "target/clean.js", "export default 1;\n");
  const configPath = write(dir, "comb.config.mjs", CONFIG);
  const eslint = createIsolatedESLint({ configPath, cwd: target });

  const { outcomes, dropped, fatal } = await runBatch(eslint, [dirty, clean], {
    action: "suppress",
    params: {},
    mode: "dry-run",
  });

  assert.deepEqual(dropped, []);
  assert.deepEqual(fatal, []);
  const byFile = new Map(outcomes.map((outcome) => [outcome.filePath, outcome]));
  assert.equal(outcomes.length, 2);

  const dirtyOutcome = byFile.get(dirty)!;
  assert.equal(dirtyOutcome.messages.length, 2);
  assert.equal(dirtyOutcome.changed, true);
  assert.equal(
    dirtyOutcome.output,
    "// eslint-disable-next-line no-debugger\ndebugger;\n// eslint-disable-next-line no-debugger\ndebugger;\n",
  );
  assert.equal(dirtyOutcome.edits.length, 2);
  assert.equal(readFileSync(dirty, "utf8"), "debugger;\ndebugger;\n", "a dry run never writes");

  const cleanOutcome = byFile.get(clean)!;
  assert.equal(cleanOutcome.changed, false);
  assert.equal(cleanOutcome.output, undefined, "no planned text is shipped when nothing changes");
  assert.deepEqual(cleanOutcome.edits, []);
});

test("runBatch in apply mode writes the suppressed text", async () => {
  const dir = tempDir();
  const target = join(dir, "target");
  const dirty = write(dir, "target/dirty.js", "debugger;\n");
  const configPath = write(dir, "comb.config.mjs", CONFIG);
  const eslint = createIsolatedESLint({ configPath, cwd: target });

  const { outcomes } = await runBatch(eslint, [dirty], {
    action: "suppress",
    params: {},
    mode: "apply",
  });

  const outcome = outcomes[0]!;
  assert.equal(outcome.changed, true);
  assert.equal(outcome.output, undefined, "on apply the planned text lives on disk, not the wire");
  assert.equal(readFileSync(dirty, "utf8"), "// eslint-disable-next-line no-debugger\ndebugger;\n");
});
