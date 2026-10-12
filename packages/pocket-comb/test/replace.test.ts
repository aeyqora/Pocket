import { test } from "node:test";
import assert from "node:assert/strict";
import { runActionForFile } from "../src/engine.js";
import type { StrategyParams } from "../src/engine.js";

function replace(text: string, from: string, to: string): ReturnType<typeof runActionForFile> {
  return runActionForFile({
    action: "replace",
    params: { from, to } as StrategyParams,
    filePath: "/repo/a.js",
    text,
    messages: [],
    apply: false,
  });
}

test("an exact rename rewrites every matching token across all four forms, every edit ledgered", () => {
  const text = [
    "/* eslint-disable no-console, no-unused-vars */",
    "const a = 1; // eslint-disable-line no-console, no-alert",
    "// eslint-disable-next-line no-console",
    "console.log(a);",
    "/* eslint-enable no-console, no-unused-vars */",
    "// eslint-disable no-alert",
    "",
  ].join("\n");

  const result = replace(text, "no-console", "@typescript-eslint/no-console");

  assert.equal(
    result.output,
    [
      "/* eslint-disable @typescript-eslint/no-console, no-unused-vars */",
      "const a = 1; // eslint-disable-line @typescript-eslint/no-console, no-alert",
      "// eslint-disable-next-line @typescript-eslint/no-console",
      "console.log(a);",
      "/* eslint-enable @typescript-eslint/no-console, no-unused-vars */",
      "// eslint-disable no-alert",
      "",
    ].join("\n"),
  );

  // One record per renamed token: the block open, the line form, the next-line
  // form, and the paired enable. Non-matching rules (and the file-level
  // no-alert) are untouched.
  assert.deepEqual(
    result.edits.map((edit) => ({
      line: edit.line,
      rule: edit.rule,
      form: edit.form,
      type: edit.editType,
    })),
    [
      { line: 1, rule: "@typescript-eslint/no-console", form: "block", type: "rename" },
      { line: 2, rule: "@typescript-eslint/no-console", form: "line", type: "rename" },
      { line: 3, rule: "@typescript-eslint/no-console", form: "next-line", type: "rename" },
      { line: 5, rule: "@typescript-eslint/no-console", form: "block", type: "rename" },
    ],
  );
  assert.equal(result.edits[0]?.before, "/* eslint-disable no-console, no-unused-vars */");
  assert.equal(result.edits[0]?.after, "/* eslint-disable @typescript-eslint/no-console, no-unused-vars */");
  assert.deepEqual(result.stats, { renamed: 4, directives: 4 });
});

test("a --from ending in '/' re-points every rule token under that prefix", () => {
  const text = [
    "// eslint-disable-next-line jsx-autofocus/autofocus, jsx-autofocus/other",
    "/* eslint-disable jsx-autofocus/nested, no-console */",
    "const a = 1; // eslint-disable-line jsx-autofocus/third",
    "",
  ].join("\n");

  const result = replace(text, "jsx-autofocus/", "jsx-a11y/");

  assert.equal(
    result.output,
    [
      "// eslint-disable-next-line jsx-a11y/autofocus, jsx-a11y/other",
      "/* eslint-disable jsx-a11y/nested, no-console */",
      "const a = 1; // eslint-disable-line jsx-a11y/third",
      "",
    ].join("\n"),
    "every token starting with the prefix is rewritten; no-console is not",
  );
  assert.deepEqual(
    result.edits.map((edit) => ({ line: edit.line, rule: edit.rule })),
    [
      { line: 1, rule: "jsx-a11y/autofocus" },
      { line: 1, rule: "jsx-a11y/other" },
      { line: 2, rule: "jsx-a11y/nested" },
      { line: 3, rule: "jsx-a11y/third" },
    ],
  );
  assert.equal(result.stats.renamed, 4);
});

test("prefix re-point does not touch a token that only shares a bare plugin name", () => {
  const result = replace("// eslint-disable-next-line jsx-autofocus\ncode();\n", "jsx-autofocus/", "jsx-a11y/");
  assert.equal(result.output, "// eslint-disable-next-line jsx-autofocus\ncode();\n");
  assert.deepEqual(result.edits, []);
});

test("bare directives are untouched and never ledgered", () => {
  const text = ["// eslint-disable-next-line", "/* eslint-disable */", "code();", ""].join("\n");
  const result = replace(text, "no-console", "no-console-2");

  assert.equal(result.output, text, "a bare guard names no rules to rename");
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.stats, { renamed: 0, directives: 0 });
});

test("a rename keeps the trailing -- description, the comment spelling and the CRLF", () => {
  const result = replace(
    "\t/* eslint-disable no-console -- legacy note */\r\ncode(); // eslint-disable-line no-console\r\n",
    "no-console",
    "no-console-2",
  );
  assert.equal(
    result.output,
    "\t/* eslint-disable no-console-2 -- legacy note */\r\ncode(); // eslint-disable-line no-console-2\r\n",
  );
});

test("a pair that matches nothing leaves the file byte-identical", () => {
  const text = "// eslint-disable-next-line no-alert\ncode();\n";
  const result = replace(text, "no-console", "no-console-2");
  assert.equal(result.output, text);
  assert.deepEqual(result.edits, []);
});

test("replace is idempotent: a second pass over its own output finds no matching token", () => {
  const text = [
    "/* eslint-disable no-console, no-unused-vars */",
    "const a = 1; // eslint-disable-line no-console, no-alert",
    "/* eslint-enable no-console, no-unused-vars */",
    "",
  ].join("\n");
  const first = replace(text, "no-console", "no-console-2");
  const second = replace(first.output, "no-console", "no-console-2");

  assert.equal(second.output, first.output);
  assert.deepEqual(second.edits, []);
});
