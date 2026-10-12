import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnusedDirectiveMessage, runActionForFile } from "../src/engine.js";
import type { StrategyParams } from "../src/engine.js";
import type { LintMessage } from "../src/types.js";

/** A crafted ESLint unused-directive message (ruleId null, located at the comment). */
function unused(message: string, line = 1, column = 1): LintMessage {
  return { ruleId: null, message, line, column, severity: 1 } as LintMessage;
}

function whole(line = 1): LintMessage {
  return unused("Unused eslint-disable directive (no problems were reported).", line);
}

function from(rules: string, line = 1): LintMessage {
  return unused(
    `Unused eslint-disable directive (no problems were reported from ${rules}).`,
    line,
  );
}

function enable(rules: string | null, line = 1): LintMessage {
  const suffix = rules === null ? "" : ` for ${rules}`;
  return unused(
    `Unused eslint-enable directive (no matching eslint-disable directives were found${suffix}).`,
    line,
  );
}

function cleanup(
  text: string,
  rules: string[],
  messages: LintMessage[],
): ReturnType<typeof runActionForFile> {
  return runActionForFile({
    action: "cleanup",
    params: { rules } as StrategyParams,
    filePath: "/repo/a.js",
    text,
    messages,
    apply: false,
  });
}

test("parses every unused-directive message shape, and only those", () => {
  assert.deepEqual(parseUnusedDirectiveMessage(whole()), {
    kind: "disable",
    rules: [],
    whole: true,
    line: 1,
    column: 1,
  });
  assert.deepEqual(parseUnusedDirectiveMessage(from("'no-alert'")), {
    kind: "disable",
    rules: ["no-alert"],
    whole: false,
    line: 1,
    column: 1,
  });
  assert.deepEqual(parseUnusedDirectiveMessage(from("'a' or 'b'")).rules, ["a", "b"]);
  assert.deepEqual(parseUnusedDirectiveMessage(from("'a', 'b', or 'c'")).rules, ["a", "b", "c"]);
  assert.equal(parseUnusedDirectiveMessage(enable(null))?.kind, "enable");
  assert.equal(parseUnusedDirectiveMessage(enable(null))?.whole, true);
  assert.deepEqual(parseUnusedDirectiveMessage(enable("'no-console'"))?.rules, ["no-console"]);

  // A normal violation is never mistaken for an unused directive.
  assert.equal(
    parseUnusedDirectiveMessage({
      ruleId: "no-console",
      message: "Unexpected console statement.",
      line: 1,
      column: 1,
      severity: 2,
    } as LintMessage),
    null,
  );
});

test("a multi-rule directive's still-used rules survive a surgical strip", () => {
  const text = "// eslint-disable-next-line no-console, no-alert, no-debugger\ncode();\n";
  // ESLint emits one message per unused rule when some rules remain used.
  const result = cleanup(text, ["no-console", "no-alert"], [from("'no-console'"), from("'no-alert'")]);

  assert.equal(result.output, "// eslint-disable-next-line no-debugger\ncode();\n");
  assert.deepEqual(
    result.edits.map((edit) => [edit.line, edit.rule, edit.editType, edit.form, edit.after]),
    [
      [1, "no-console", "prune", "next-line", "// eslint-disable-next-line no-debugger"],
      [1, "no-alert", "prune", "next-line", "// eslint-disable-next-line no-debugger"],
    ],
  );
  assert.equal(result.stats.stripped, 1);
  assert.equal(result.stats.deleted, 0);
});

test("a fully-unused multi-rule message still prunes only the config's rules", () => {
  const text = "// eslint-disable-next-line no-console, no-alert\ncode();\n";
  const result = cleanup(text, ["no-console"], [from("'no-console' or 'no-alert'")]);

  assert.equal(
    result.output,
    "// eslint-disable-next-line no-alert\ncode();\n",
    "no-alert is unused too, but it is not the config's to prune",
  );
  assert.deepEqual(result.edits.map((edit) => edit.rule), ["no-console"]);
});

test("a non-config unused rule is left untouched and is not reported", () => {
  const text = "// eslint-disable-next-line no-alert\ncode();\n";
  const result = cleanup(text, ["no-console"], [from("'no-alert'")]);
  assert.equal(result.output, text);
  assert.deepEqual(result.edits, []);
  assert.deepEqual(result.notActionable, []);
});

test("a bare directive is deleted whole when ESLint flags the whole comment", () => {
  const text = ["/* eslint-disable */", "/* eslint-disable */", ""].join("\n");
  const result = cleanup(text, ["no-console"], [whole(1)]);

  assert.equal(result.output, "/* eslint-disable */\n");
  assert.deepEqual(
    result.edits.map((edit) => [edit.line, edit.rule, edit.editType, edit.form]),
    [[1, "*", "prune", "file-level"]],
    "a bare deletion is ledgered with the whole-rule-set sentinel",
  );
  assert.deepEqual(result.notActionable, [
    {
      file: "/repo/a.js",
      line: 2,
      form: "file-level",
      reason: "bare",
      text: "/* eslint-disable */",
    },
  ]);
  assert.equal(result.stats.skippedBare, 1);
});

test("unused eslint-enable directives are removed whole, bare or named", () => {
  const text = ["/* eslint-enable no-console */", "/* eslint-enable */", ""].join("\n");
  const result = cleanup(text, ["no-console"], [enable("'no-console'", 1), enable(null, 2)]);

  assert.equal(result.output, "");
  assert.deepEqual(
    result.edits.map((edit) => [edit.line, edit.rule, edit.editType, edit.form]),
    [
      [1, "no-console", "prune", "block"],
      [2, "*", "prune", "block"],
    ],
  );
});

test("an emptied line-form suffix directive keeps the code it rides on", () => {
  const result = cleanup("doThing(); // eslint-disable-line no-console\n", ["no-console"], [
    from("'no-console'"),
  ]);
  assert.equal(result.output, "doThing();\n");
  assert.equal(result.edits[0]?.after, "doThing();");
  assert.equal(result.edits[0]?.form, "line");
});

test("CRLF files keep their line endings through a prune", () => {
  const wholeLine = cleanup("// eslint-disable-next-line no-console\r\ncode();\r\n", ["no-console"], [
    from("'no-console'"),
  ]);
  assert.equal(wholeLine.output, "code();\r\n");

  const suffix = cleanup("doThing(); // eslint-disable-line no-console\r\n", ["no-console"], [
    from("'no-console'"),
  ]);
  assert.equal(suffix.output, "doThing();\r\n");
});

test("a message pointing at no directive is ignored (defensive)", () => {
  const result = cleanup("code();\n", ["no-console"], [whole(5)]);
  assert.equal(result.output, "code();\n");
  assert.deepEqual(result.edits, []);
});

test("a non-config unused enable is left untouched (config-scoped)", () => {
  const result = cleanup("/* eslint-enable no-alert */\n", ["no-console"], [enable("'no-alert'")]);
  assert.equal(result.output, "/* eslint-enable no-alert */\n");
  assert.deepEqual(result.edits, []);
});

test("a pruned block-open's paired enable loses the same rule, in one pass", () => {
  const text = [
    "/* eslint-disable no-console, no-unused-vars */",
    "console.log(1);",
    "/* eslint-enable no-console, no-unused-vars */",
    "",
  ].join("\n");
  const result = cleanup(text, ["no-console", "no-unused-vars"], [from("'no-unused-vars'", 1)]);

  assert.equal(
    result.output,
    [
      "/* eslint-disable no-console */",
      "console.log(1);",
      "/* eslint-enable no-console */",
      "",
    ].join("\n"),
    "both sides of the pair are reconciled, so a re-lint finds nothing",
  );
  assert.deepEqual(
    result.edits.map((edit) => [edit.line, edit.rule, edit.form]),
    [
      [1, "no-unused-vars", "block"],
      [3, "no-unused-vars", "block"],
    ],
  );
});

test("a pruned bare block-open takes a named enable with it (no orphan)", () => {
  const text = ["/* eslint-disable */", "/* eslint-enable no-console */", ""].join("\n");
  const result = cleanup(text, ["no-console"], [whole(1)]);

  assert.equal(result.output, "");
  assert.deepEqual(
    result.edits.map((edit) => [edit.line, edit.rule, edit.form]),
    [
      [1, "*", "block"],
      [2, "no-console", "block"],
    ],
  );
});

test("cleanup is idempotent: a second pass over its own output changes nothing", () => {
  const text = [
    "/* eslint-disable no-console, no-unused-vars */",
    "console.log(1);",
    "/* eslint-enable no-console, no-unused-vars */",
    "// eslint-disable-next-line no-unused-vars",
    "code();",
    "",
  ].join("\n");
  const first = cleanup(text, ["no-console", "no-unused-vars"], [from("'no-unused-vars'", 1), from("'no-unused-vars'", 4)]);
  // A re-lint of the pruned text reports no unused directives, so a second pass
  // is a no-op (the end-to-end suite exercises this against real ESLint).
  const second = cleanup(first.output, ["no-console", "no-unused-vars"], []);

  assert.equal(second.output, first.output);
  assert.deepEqual(second.edits, []);
});
