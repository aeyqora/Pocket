import { test } from "node:test";
import assert from "node:assert/strict";
import { runActionForFile } from "../src/engine.js";
import type { SuppressParams } from "../src/engine.js";
import type { LintMessage } from "../src/types.js";

function msg(line: number, rule: string, severity: 1 | 2 = 1): LintMessage {
  return { ruleId: rule, severity, message: "", line, column: 1 } as LintMessage;
}

function run(
  text: string,
  messages: LintMessage[],
  params: SuppressParams = {},
): ReturnType<typeof runActionForFile> {
  return runActionForFile({
    action: "suppress",
    params,
    filePath: "/repo/reuse.js",
    text,
    messages,
    apply: false,
  });
}

test("without --reuse-blocks the default stays the minimal-span insert", () => {
  const text =
    "/* eslint-disable no-unused-vars */\n" +
    "function f() {\n" +
    '  console.log("x");\n' +
    "}\n" +
    "/* eslint-enable no-unused-vars */\n";

  const result = run(text, [msg(3, "no-console")]);

  assert.equal(
    result.output,
    "/* eslint-disable no-unused-vars */\n" +
      "function f() {\n" +
      "  // eslint-disable-next-line no-console\n" +
      '  console.log("x");\n' +
      "}\n" +
      "/* eslint-enable no-unused-vars */\n",
    "the minimal-span insert is untouched",
  );
  assert.equal(result.edits[0]?.editType, "insert");
  assert.equal(result.edits[0]?.form, "next-line");
});

test("--reuse-blocks prepends onto the enclosing block-open's list, preserving the description", () => {
  const text =
    "/* eslint-disable no-unused-vars -- legacy */\n" +
    "function f() {\n" +
    '  console.log("x");\n' +
    "}\n" +
    "/* eslint-enable no-unused-vars */\n";

  const result = run(text, [msg(3, "no-console")], { reuseBlocks: true });

  assert.equal(
    result.output,
    "/* eslint-disable no-console, no-unused-vars -- legacy */\n" +
      "function f() {\n" +
      '  console.log("x");\n' +
      "}\n" +
      "/* eslint-enable no-unused-vars */\n",
    "the rule is prepended at position 0 and the description survives",
  );
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0]?.editType, "prepend");
  assert.equal(result.edits[0]?.form, "block");
  assert.equal(result.edits[0]?.rule, "no-console");
  assert.equal(result.edits[0]?.line, 1, "the ledger anchors to the directive line");
  assert.equal(result.edits[0]?.before, "/* eslint-disable no-unused-vars -- legacy */");
  assert.equal(result.edits[0]?.after, "/* eslint-disable no-console, no-unused-vars -- legacy */");
});

test("--reuse-blocks prepends onto a file-level directive and ledgers it as file-level", () => {
  const text = "/* eslint-disable no-console */\nconst unused = 1;\n";

  const result = run(text, [msg(2, "no-unused-vars")], { reuseBlocks: true });

  assert.equal(result.output, "/* eslint-disable no-unused-vars, no-console */\nconst unused = 1;\n");
  assert.equal(result.edits[0]?.form, "file-level");
  assert.equal(result.edits[0]?.line, 1);
});

test("--reuse-blocks handles the // spelling of a block/file-level directive", () => {
  const text = "// eslint-disable no-unused-vars\nconsole.log(1);\n";

  const result = run(text, [msg(2, "no-console")], { reuseBlocks: true });

  assert.equal(result.output, "// eslint-disable no-console, no-unused-vars\nconsole.log(1);\n");
});

test("--reuse-blocks finds the nearest enclosing guard, not an outer one", () => {
  const text =
    "/* eslint-disable no-console */\n" +
    "function outer() {\n" +
    "  /* eslint-disable no-unused-vars */\n" +
    '  console.log("x");\n' +
    "  /* eslint-enable no-unused-vars */\n" +
    "}\n" +
    "/* eslint-enable no-console */\n";

  const result = run(text, [msg(4, "no-debugger")], { reuseBlocks: true });

  assert.equal(
    result.output,
    "/* eslint-disable no-console */\n" +
      "function outer() {\n" +
      "  /* eslint-disable no-debugger, no-unused-vars */\n" +
      '  console.log("x");\n' +
      "  /* eslint-enable no-unused-vars */\n" +
      "}\n" +
      "/* eslint-enable no-console */\n",
    "the inner block-open is the enclosing guard",
  );
  assert.equal(result.edits[0]?.line, 3);
});

test("--reuse-blocks ignores a guard whose block already closed below the violation", () => {
  const text =
    "/* eslint-disable no-unused-vars */\n" +
    "x;\n" +
    "/* eslint-enable no-unused-vars */\n" +
    'console.log("y");\n';

  const result = run(text, [msg(4, "no-console")], { reuseBlocks: true });

  assert.equal(
    result.output,
    "/* eslint-disable no-unused-vars */\n" +
      "x;\n" +
      "/* eslint-enable no-unused-vars */\n" +
      "// eslint-disable-next-line no-console\n" +
      'console.log("y");\n',
    "a closed block is not an enclosing guard; the default insert applies",
  );
});

test("--reuse-blocks falls back to the minimal-span insert with no enclosing guard", () => {
  const text = "const x = 1;\nconsole.log(x);\n";

  const result = run(text, [msg(2, "no-console")], { reuseBlocks: true });

  assert.equal(result.output, "const x = 1;\n// eslint-disable-next-line no-console\nconsole.log(x);\n");
  assert.equal(result.edits[0]?.editType, "insert");
});

test("--reuse-blocks skips a bare enclosing guard rather than rewriting it", () => {
  const text = "/* eslint-disable */\nconsole.log(1);\n";

  const result = run(text, [msg(2, "no-console")], { reuseBlocks: true });

  assert.equal(result.output, text, "a bare guard is never rewritten");
  assert.deepEqual(result.edits, []);
  assert.equal(result.stats.skippedBare, 1);
});

test("--reuse-blocks skips a guard that already lists the rule", () => {
  const text = "/* eslint-disable no-console */\nconsole.log(1);\n";

  const result = run(text, [msg(2, "no-console")], { reuseBlocks: true });

  assert.equal(result.output, text);
  assert.deepEqual(result.edits, []);
  assert.equal(result.stats.skippedGuarded, 1);
});

test("--reuse-blocks preserves CRLF on the rewritten directive", () => {
  const text = "/* eslint-disable no-unused-vars */\r\nconsole.log(1);\r\n";

  const result = run(text, [msg(2, "no-console")], { reuseBlocks: true });

  assert.equal(result.output, "/* eslint-disable no-console, no-unused-vars */\r\nconsole.log(1);\r\n");
});
