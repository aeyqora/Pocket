import { test } from "node:test";
import assert from "node:assert/strict";
import { censusFileScan, censusFiles } from "../src/census.js";

/**
 * The census unit seam (spec §6.6): pure counting over a file's lines. It counts
 * **disable** directives only — an `eslint-enable` is a block closer, not a
 * suppression — across all four forms, per rule, with bare directives counted
 * once per form (`rule: null`).
 */
test("censusFileScan.entries counts every disable directive across all four forms; bare per form; enables excluded", () => {
  const entries = censusFileScan([
    "/* eslint-disable no-console, no-unused-vars */",
    "const a = 1;",
    "code(); // eslint-disable-line no-console",
    "// eslint-disable-next-line no-debugger",
    "debugger;",
    "/* eslint-enable no-console, no-unused-vars */",
    "/* eslint-disable no-alert */",
    "// eslint-disable",
    "",
  ]).entries;

  assert.deepEqual(entries, [
    { form: "block", rule: "no-console" },
    { form: "block", rule: "no-unused-vars" },
    { form: "line", rule: "no-console" },
    { form: "next-line", rule: "no-debugger" },
    { form: "file-level", rule: "no-alert" },
    { form: "file-level", rule: null },
  ]);
});

test("censusFileScan counts directives once each and excludes enables from both grains", () => {
  const scan = censusFileScan([
    "/* eslint-disable no-console, no-unused-vars */",
    "foo();",
    "/* eslint-enable no-console, no-unused-vars */",
    "// eslint-disable-next-line no-console",
    "",
  ]);
  assert.equal(scan.disables.length, 2, "the enable is not a disable");
  assert.deepEqual(scan.entries, [
    { form: "block", rule: "no-console" },
    { form: "block", rule: "no-unused-vars" },
    { form: "next-line", rule: "no-console" },
  ]);
});

test("censusFiles aggregates (form, rule) totals and per-file counts with stable ordering", () => {
  const result = censusFiles([
    { file: "/repo/b.js", text: "// eslint-disable-next-line no-console\n" },
    {
      file: "/repo/a.js",
      text: [
        "// eslint-disable-next-line no-console, no-debugger",
        "code(); // eslint-disable-line no-console",
        "/* eslint-disable */",
        "",
      ].join("\n"),
    },
    { file: "/repo/empty.js", text: "const x = 1;\n" },
  ]);

  // Form canonical order (next-line, line, block, file-level), then rule
  // alphabetical, bare last. A multi-rule directive contributes one entry per
  // rule it names.
  assert.deepEqual(result.totals, [
    { form: "next-line", rule: "no-console", count: 2 },
    { form: "next-line", rule: "no-debugger", count: 1 },
    { form: "line", rule: "no-console", count: 1 },
    { form: "file-level", rule: null, count: 1 },
  ]);
  // Per-file counts count directives (a multi-rule directive is one); files by
  // path, and a file with no directives is not listed.
  assert.deepEqual(result.byFile, [
    { file: "/repo/a.js", count: 3 },
    { file: "/repo/b.js", count: 1 },
  ]);
  assert.deepEqual(result.byForm, [
    { form: "next-line", count: 2 },
    { form: "line", count: 1 },
    { form: "file-level", count: 1 },
  ]);
  assert.equal(result.directives, 4);
});

test("censusFiles is order-independent: shuffled input yields byte-identical totals and files", () => {
  const files = [
    { file: "/repo/a.js", text: "// eslint-disable-next-line no-console\n" },
    { file: "/repo/b.js", text: "/* eslint-disable no-alert */\ncode();\n" },
    { file: "/repo/c.js", text: "// eslint-disable-next-line no-console\n" },
  ];
  const forward = censusFiles(files);
  const backward = censusFiles([...files].reverse());
  assert.deepEqual(backward.totals, forward.totals);
  assert.deepEqual(backward.byFile, forward.byFile);
  assert.deepEqual(backward.byForm, forward.byForm);
  assert.equal(backward.directives, forward.directives);
});

test("the census counts JSX and suffix block directives like any other spelling", () => {
  const scan = censusFileScan([
    "{/* eslint-disable-next-line no-console */}",
    "{ /* eslint-disable no-alert */ }",
    "<div>{value}</div>{/* eslint-disable-line no-debugger */}",
    "code(); /* eslint-disable-line no-unused-vars */",
    "",
  ]);

  assert.deepEqual(scan.entries, [
    { form: "next-line", rule: "no-console" },
    { form: "file-level", rule: "no-alert" },
    { form: "line", rule: "no-debugger" },
    { form: "line", rule: "no-unused-vars" },
  ]);
  assert.equal(scan.disables.length, 4);
});
