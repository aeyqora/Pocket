import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./harness.js";
import {
  applySuppressEdits,
  planSuppressEdits,
  runActionForFile,
  scanSuppressFile,
  splitRuleList,
} from "../src/engine.js";
import type { PlannedEdit, StrategyParams, SuppressParams } from "../src/engine.js";
import type { EditRecord, LintMessage } from "../src/types.js";

const FIXTURES = join(ROOT, "test", "fixtures", "suppress");
const GOLDEN = join(ROOT, "test", "golden", "suppress");

function read(dir: string, name: string): string {
  return readFileSync(join(dir, name), "utf8");
}

function msg(line: number, rule: string, severity: 1 | 2 = 1): LintMessage {
  return { ruleId: rule, severity, message: "", line, column: 1 } as LintMessage;
}

interface Case {
  messages: Array<{ line: number; rule: string; severity?: 1 | 2 }>;
  params?: SuppressParams;
  /** Expected per-file stats, when the case pins them. */
  stats?: Record<string, number>;
  /** Expected number of ledger records, when the case pins it. */
  editRecords?: number;
}

/**
 * The golden corpus: each fixture is run through the engine with these messages
 * and must equal the committed golden file byte for byte. The goldens are
 * hand-authored from spec §6.1 semantics, not captured from the engine.
 */
const CASES: Record<string, Case> = {
  "insert-basic.js": { messages: [{ line: 2, rule: "no-console" }], stats: { inserted: 1, prepended: 0, skippedBare: 0, skippedGuarded: 0 } },
  "insert-indent.js": { messages: [{ line: 3, rule: "no-console" }] },
  "insert-reason.js": { messages: [{ line: 1, rule: "no-debugger" }], params: { reason: "legacy code" } },
  "multi-rule.js": {
    messages: [
      { line: 1, rule: "no-unused-vars", severity: 2 },
      { line: 1, rule: "no-console" },
    ],
    stats: { inserted: 1, prepended: 0, skippedBare: 0, skippedGuarded: 0 },
    editRecords: 2,
  },
  "prepend-next.js": { messages: [{ line: 2, rule: "no-unused-vars" }], stats: { inserted: 0, prepended: 1, skippedBare: 0, skippedGuarded: 0 } },
  "prepend-next-nodesc.js": { messages: [{ line: 2, rule: "no-unused-vars" }] },
  "prepend-line.js": { messages: [{ line: 1, rule: "no-unused-vars" }] },
  "prepend-line-multi.js": {
    messages: [
      { line: 1, rule: "ruleA" },
      { line: 1, rule: "ruleB" },
    ],
  },
  "guard-complete.js": { messages: [{ line: 2, rule: "no-console" }], stats: { inserted: 0, prepended: 0, skippedBare: 0, skippedGuarded: 1 } },
  "guard-bare.js": { messages: [{ line: 2, rule: "no-console" }], stats: { inserted: 0, prepended: 0, skippedBare: 1, skippedGuarded: 0 } },
  "line-guard-bare.js": { messages: [{ line: 1, rule: "no-console" }], stats: { inserted: 0, prepended: 0, skippedBare: 1, skippedGuarded: 0 } },
  "block-minimal-span.js": { messages: [{ line: 3, rule: "no-console" }] },
  "file-level-minimal-span.js": { messages: [{ line: 2, rule: "no-unused-vars" }] },
  "above-line-form-not-guard.js": { messages: [{ line: 2, rule: "no-console" }] },
};

function run(name: string, params: SuppressParams = {}): ReturnType<typeof runActionForFile> {
  const spec = CASES[name]!;
  return runActionForFile({
    action: "suppress",
    params: { ...(spec.params ?? {}), ...params } as unknown as StrategyParams,
    filePath: `/repo/${name}`,
    text: read(FIXTURES, name),
    messages: spec.messages.map((m) => msg(m.line, m.rule, m.severity ?? 1)),
    apply: false,
  });
}

test("the fixture corpus and its goldens are complete", () => {
  const fixtures = readdirSync(FIXTURES).sort();
  const goldens = readdirSync(GOLDEN).sort();
  assert.deepEqual(goldens, fixtures, "every fixture has a golden twin");
  assert.deepEqual(fixtures, Object.keys(CASES).sort(), "every fixture has a case");
});

for (const name of Object.keys(CASES)) {
  test(`golden: ${name}`, () => {
    const result = run(name);
    assert.equal(result.output, read(GOLDEN, name), "output is byte-identical to the golden");
    if (CASES[name]!.stats !== undefined) {
      assert.deepEqual(result.stats, CASES[name]!.stats);
    }
    if (CASES[name]!.editRecords !== undefined) {
      assert.equal(result.edits.length, CASES[name]!.editRecords);
    }
  });
}

test("--reason applies to inserted directives only, never to prepends", () => {
  const inserted = run("insert-basic.js", { reason: "ticket-123" });
  assert.match(inserted.output, /\/\/ eslint-disable-next-line no-console -- ticket-123/);

  const prepended = run("prepend-next.js", { reason: "IGNORED" });
  assert.equal(
    prepended.output,
    read(GOLDEN, "prepend-next.js"),
    "the existing description is preserved and no reason is appended",
  );
  assert.doesNotMatch(prepended.output, /IGNORED/);
});

test("multi-rule lines aggregate into one directive and ledger one record per rule", () => {
  const result = run("multi-rule.js");
  assert.equal(result.stats.inserted, 1, "one directive, not one per rule");
  assert.equal(result.edits.length, 2, "one ledger record per rule in the directive");

  const directive = "// eslint-disable-next-line no-unused-vars, no-console";
  const expected: EditRecord[] = [
    {
      file: "/repo/multi-rule.js",
      line: 1,
      rule: "no-unused-vars",
      editType: "insert",
      form: "next-line",
      after: directive,
    },
    {
      file: "/repo/multi-rule.js",
      line: 1,
      rule: "no-console",
      editType: "insert",
      form: "next-line",
      after: directive,
    },
  ];
  assert.deepEqual(result.edits, expected);
});

test("a prepend records before/after on the rewritten directive line", () => {
  const result = run("prepend-next.js");
  assert.deepEqual(result.edits, [
    {
      file: "/repo/prepend-next.js",
      line: 2,
      rule: "no-unused-vars",
      editType: "prepend",
      form: "next-line",
      before: "// eslint-disable-next-line no-console -- keep me",
      after: "// eslint-disable-next-line no-unused-vars, no-console -- keep me",
    },
  ]);
});

test("bare and already-guarded branches are skip-only: no edits, unchanged text", () => {
  for (const name of ["guard-bare.js", "guard-complete.js", "line-guard-bare.js"]) {
    const result = run(name);
    assert.equal(result.output, read(FIXTURES, name), `${name} is never rewritten`);
    assert.deepEqual(result.edits, [], `${name} emits no ledger records`);
  }
});

test("the lazy scan reads only the violation's own line and the line above", () => {
  const lines = [
    "const a = 1;",
    "// eslint-disable-next-line no-console",
    'console.log("x");',
    "const b = 2;",
  ];
  const accessed: number[] = [];
  const proxy = new Proxy(lines, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) accessed.push(Number(prop));
      return Reflect.get(target, prop, receiver);
    },
  });

  // Violation on line 3 (0-based index 2); its guard sits on line 2 (index 1).
  scanSuppressFile(proxy, [msg(3, "no-console")]);
  assert.deepEqual(
    accessed.sort((a, b) => a - b),
    [1, 2],
    "only the violation line and the line above are ever read",
  );
});

test("the lazy scan reads only the violation's own line when a line-form guard rides on it", () => {
  const lines = ["", "", 'console.log("x"); // eslint-disable-line no-console'];
  const accessed: number[] = [];
  const proxy = new Proxy(lines, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) accessed.push(Number(prop));
      return Reflect.get(target, prop, receiver);
    },
  });

  scanSuppressFile(proxy, [msg(3, "no-unused-vars")]);
  assert.deepEqual(accessed, [2], "the line above is not read when the guard is on the violation line");
});

test("CRLF files keep their line endings through insert and prepend", () => {
  const inserted = runActionForFile({
    action: "suppress",
    params: {},
    filePath: "/repo/crlf.js",
    text: 'console.log("x");\r\nconst y = 1;\r\n',
    messages: [msg(1, "no-console")],
    apply: false,
  });
  assert.equal(
    inserted.output,
    '// eslint-disable-next-line no-console\r\nconsole.log("x");\r\nconst y = 1;\r\n',
  );

  const prependedLine = runActionForFile({
    action: "suppress",
    params: {},
    filePath: "/repo/crlf.js",
    text: 'console.log("x"); // eslint-disable-line no-console\r\n',
    messages: [msg(1, "no-unused-vars")],
    apply: false,
  });
  assert.equal(
    prependedLine.output,
    'console.log("x"); // eslint-disable-line no-unused-vars, no-console\r\n',
  );

  const prependedNext = runActionForFile({
    action: "suppress",
    params: {},
    filePath: "/repo/crlf.js",
    text: '// eslint-disable-next-line no-console\r\nconsole.log("x");\r\n',
    messages: [msg(2, "no-unused-vars")],
    apply: false,
  });
  assert.equal(
    prependedNext.output,
    '// eslint-disable-next-line no-unused-vars, no-console\r\nconsole.log("x");\r\n',
  );
});

test("splitRuleList separates the rule list from a trailing -- description", () => {
  assert.deepEqual(splitRuleList("no-console, no-unused-vars -- because it logs"), {
    rules: ["no-console", "no-unused-vars"],
    desc: "because it logs",
    bare: false,
  });
  assert.deepEqual(splitRuleList(""), { rules: [], desc: "", bare: true });
  assert.deepEqual(splitRuleList("-- only a description"), { rules: [], desc: "only a description", bare: true });
});

test("applySuppressEdits applies bottom-up so indices stay valid", () => {
  const lines = ["a();", "b();", "c();"];
  const edits: PlannedEdit[] = [
    { kind: "insert", line: 1, index: 0, added: ["r1"], after: "// one", form: "next-line" },
    { kind: "insert", line: 3, index: 2, added: ["r2"], after: "// three", form: "next-line" },
  ];
  applySuppressEdits(lines, edits);
  assert.deepEqual(lines, ["// one", "a();", "b();", "// three", "c();"]);
});

test("plan produces no edit when there are no messages", () => {
  const plan = planSuppressEdits([], {});
  assert.deepEqual(plan, { edits: [], skippedBare: 0, skippedGuarded: 0 });
});
