import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRunReport,
  rollupByFile,
  rollupByForm,
  rollupByRule,
  type RunMeta,
} from "../src/ledger.js";
import type { EditRecord } from "../src/types.js";

function record(overrides: Partial<EditRecord>): EditRecord {
  return {
    file: "/repo/a.js",
    line: 1,
    rule: "no-console",
    editType: "insert",
    form: "next-line",
    ...overrides,
  };
}

const EDITS: EditRecord[] = [
  record({ file: "/repo/b.js", rule: "no-console", line: 3 }),
  record({ file: "/repo/a.js", rule: "no-unused-vars", editType: "prepend", form: "line" }),
  record({ file: "/repo/a.js", rule: "no-console", line: 9 }),
  record({ file: "/repo/b.js", rule: "no-console", line: 4 }),
];

test("byRule counts alphabetically", () => {
  assert.deepEqual(rollupByRule(EDITS), [
    { rule: "no-console", count: 3 },
    { rule: "no-unused-vars", count: 1 },
  ]);
});

test("byForm counts in canonical form order and skips null forms", () => {
  const withNull = [...EDITS, record({ rule: "x", form: null })];
  assert.deepEqual(rollupByForm(withNull), [
    { form: "next-line", count: 3 },
    { form: "line", count: 1 },
  ]);
});

test("byFile counts are ordered by path", () => {
  assert.deepEqual(rollupByFile(EDITS), [
    { file: "/repo/a.js", count: 2 },
    { file: "/repo/b.js", count: 2 },
  ]);
});

test("buildRunReport assembles metadata, the ledger copy, and all rollups", () => {
  const meta: RunMeta = {
    tool: "pocket-comb",
    version: "0.2.0",
    action: "suppress",
    configPath: "/repo/comb.config.mjs",
    configHash: "abc",
    target: "/repo",
    startedAt: "2026-10-12T00:00:00.000Z",
    durationMs: 12,
    dryRun: true,
    workers: 4,
    counts: { discovered: 2, linted: 2, dropped: 0, touched: 2 },
  };
  const report = buildRunReport(meta, EDITS);
  assert.equal(report.meta, meta);
  assert.deepEqual(report.edits, EDITS);
  assert.deepEqual(report.byRule, rollupByRule(EDITS));
  assert.deepEqual(report.byForm, rollupByForm(EDITS));
  assert.deepEqual(report.byFile, rollupByFile(EDITS));
});
