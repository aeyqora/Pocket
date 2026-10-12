import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createIsolatedESLint } from "../src/eslint.js";
import { runActionForFile, runBatch } from "../src/engine.js";
import { cleanupTemps, tempDir, write } from "./harness.js";
import type { LintMessage } from "../src/types.js";

after(cleanupTemps);

const CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-debugger": "warn", "no-unused-vars": "error" } },
];
`;

function message(severity: 1 | 2, rule: string): LintMessage {
  return {
    ruleId: rule,
    severity,
    message: "boom",
    line: 1,
    column: 1,
  } as LintMessage;
}

test("the lint-only strategy edits nothing and tallies messages by severity", () => {
  const result = runActionForFile({
    action: "suppress",
    params: {},
    filePath: "/tmp/x.js",
    text: "debugger;\nvar unused = 1;\n",
    messages: [message(1, "no-debugger"), message(2, "no-unused-vars")],
    apply: false,
  });

  assert.equal(result.output, "debugger;\nvar unused = 1;\n", "text is returned unchanged");
  assert.deepEqual(result.edits, [], "no edits exist until a real strategy lands");
  assert.deepEqual(result.stats, { messages: 2, errors: 1, warnings: 1 });
});

test("runBatch lints a batch and produces one unchanged outcome per linted file", async () => {
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
  assert.equal(byFile.get(dirty)?.messages.length, 2);
  assert.equal(byFile.get(clean)?.messages.length, 0);
  for (const outcome of outcomes) {
    assert.equal(outcome.changed, false);
    assert.equal(outcome.output, undefined, "no planned text is shipped when nothing changes");
    assert.deepEqual(outcome.edits, []);
  }
});
