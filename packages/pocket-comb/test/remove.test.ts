import { test } from "node:test";
import assert from "node:assert/strict";
import { runActionForFile } from "../src/engine.js";
import type { StrategyParams } from "../src/engine.js";

function remove(text: string, rules: string[]): ReturnType<typeof runActionForFile> {
  return runActionForFile({
    action: "remove",
    params: { rules } as StrategyParams,
    filePath: "/repo/a.js",
    text,
    messages: [],
    apply: false,
  });
}

test("remove strips exactly the config's rules across all four forms; others are untouched", () => {
  const text = [
    "/* eslint-disable no-console, no-unused-vars */",
    "const a = 1; // eslint-disable-line no-console, no-alert",
    "// eslint-disable-next-line no-console, no-debugger",
    "debugger;",
    "/* eslint-enable no-console, no-unused-vars */",
    "/* eslint-disable no-alert */",
    "// eslint-disable",
    "",
  ].join("\n");

  const result = remove(text, ["no-console", "no-unused-vars"]);

  assert.equal(
    result.output,
    [
      "const a = 1; // eslint-disable-line no-alert",
      "// eslint-disable-next-line no-debugger",
      "debugger;",
      "/* eslint-disable no-alert */",
      "// eslint-disable",
      "",
    ].join("\n"),
  );

  // One record per removed (directive, rule): line1 (2), line2 (1), line3 (1),
  // the paired enable on line5 (2).
  assert.deepEqual(
    result.edits.map((edit) => ({ line: edit.line, rule: edit.rule, form: edit.form, type: edit.editType })),
    [
      { line: 1, rule: "no-console", form: "block", type: "strip" },
      { line: 1, rule: "no-unused-vars", form: "block", type: "strip" },
      { line: 2, rule: "no-console", form: "line", type: "strip" },
      { line: 3, rule: "no-console", form: "next-line", type: "strip" },
      { line: 5, rule: "no-console", form: "block", type: "strip" },
      { line: 5, rule: "no-unused-vars", form: "block", type: "strip" },
    ],
  );
  assert.deepEqual(result.stats, { stripped: 2, deleted: 2, skippedBare: 1, rulesRemoved: 4 });
  assert.deepEqual(result.notActionable, [
    { file: "/repo/a.js", line: 7, form: "file-level", reason: "bare", text: "// eslint-disable" },
  ]);
});

test("an emptied directive is deleted entirely — no bare eslint-disable is ever produced", () => {
  const result = remove("// eslint-disable-next-line no-console\nconst a = 1;\n", ["no-console"]);
  assert.equal(result.output, "const a = 1;\n");
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0]?.editType, "strip");
  assert.equal(result.edits[0]?.after, undefined, "a deleted directive has no after text");
  assert.equal(result.edits[0]?.before, "// eslint-disable-next-line no-console");
  assert.doesNotMatch(result.output, /eslint-disable/);
});

test("a file-level directive whose list empties is deleted (there is no enable to pair)", () => {
  const result = remove("/* eslint-disable no-console */\ncode();\n", ["no-console"]);
  assert.equal(result.output, "code();\n");
  assert.equal(result.stats.deleted, 1);
});

test("a block-open that empties takes its paired eslint-enable with it, both ledgered", () => {
  const text = ["/* eslint-disable no-console */", "const a = 1;", "/* eslint-enable no-console */", ""].join(
    "\n",
  );
  const result = remove(text, ["no-console"]);

  assert.equal(result.output, "const a = 1;\n", "both the open and its closer are gone");
  assert.equal(result.edits.length, 2);
  assert.deepEqual(
    result.edits.map((edit) => ({ line: edit.line, rule: edit.rule, form: edit.form })),
    [
      { line: 1, rule: "no-console", form: "block" },
      { line: 3, rule: "no-console", form: "block" },
    ],
  );
  assert.equal(result.edits[1]?.before, "/* eslint-enable no-console */");
});

test("a multi-rule block that only loses some rules keeps the rest and its enable", () => {
  const text = [
    "/* eslint-disable no-console, no-unused-vars */",
    "const a = 1;",
    "/* eslint-enable no-console, no-unused-vars */",
    "",
  ].join("\n");
  const result = remove(text, ["no-console"]);

  assert.equal(
    result.output,
    [
      "/* eslint-disable no-unused-vars */",
      "const a = 1;",
      "/* eslint-enable no-console, no-unused-vars */",
      "",
    ].join("\n"),
    "the closer stays: it still closes a surviving disable",
  );
  assert.equal(result.edits.length, 1, "only the block-open's list changed");
  assert.equal(result.edits[0]?.after, "/* eslint-disable no-unused-vars */");
});

test("bare directives are untouched and reported as not-actionable", () => {
  const text = ["// eslint-disable-next-line", "/* eslint-disable */", "code();", ""].join("\n");
  const result = remove(text, ["no-console"]);

  assert.equal(result.output, text, "bare guards guard everything and are never rewritten");
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.notActionable, [
    {
      file: "/repo/a.js",
      line: 1,
      form: "next-line",
      reason: "bare",
      text: "// eslint-disable-next-line",
    },
    { file: "/repo/a.js", line: 2, form: "file-level", reason: "bare", text: "/* eslint-disable */" },
  ]);
  assert.equal(result.stats.skippedBare, 2);
});

test("remove is idempotent: a second pass over its own output changes nothing", () => {
  const text = [
    "/* eslint-disable no-console, no-unused-vars */",
    "const a = 1; // eslint-disable-line no-console, no-alert",
    "/* eslint-enable no-console, no-unused-vars */",
    "",
  ].join("\n");
  const first = remove(text, ["no-console", "no-unused-vars"]);
  const second = remove(first.output, ["no-console", "no-unused-vars"]);

  assert.equal(second.output, first.output);
  assert.deepEqual(second.edits, []);
});

test("CRLF files keep their line endings through a strip", () => {
  const result = remove("code(); // eslint-disable-line no-console, no-alert\r\n", ["no-console"]);
  assert.equal(result.output, "code(); // eslint-disable-line no-alert\r\n");
});

test("a directive with none of the config's rules is left completely alone", () => {
  const text = "// eslint-disable-next-line no-alert\ncode();\n";
  const result = remove(text, ["no-console"]);
  assert.equal(result.output, text);
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.notActionable, []);
});
