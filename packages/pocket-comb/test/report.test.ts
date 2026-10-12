import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { buildRunReport, type RunMeta } from "../src/ledger.js";
import {
  defaultReportPath,
  emitReport,
  renderCsv,
  renderHtml,
  renderJson,
  resolveReportOptions,
  type CensusReport,
} from "../src/report/index.js";
import { main } from "../src/cli.js";
import { cleanupTemps, fakeIo, tempDir, write } from "./harness.js";
import type { EditRecord } from "../src/types.js";

after(cleanupTemps);

const META: RunMeta = {
  tool: "pocket-comb",
  version: "0.1.0",
  action: "suppress",
  configPath: "/repo/comb.config.mjs",
  configHash: "9f2c0a",
  target: "/repo/target",
  startedAt: "2026-10-12T00:00:00.000Z",
  durationMs: 12,
  dryRun: true,
  workers: 4,
  counts: { discovered: 3, linted: 3, dropped: 0, touched: 2 },
};

/** Tricky ledger rows: a comma, a quote and an embedded newline all in play. */
const EDITS: EditRecord[] = [
  {
    file: "/repo/a.js",
    line: 1,
    rule: "no-console",
    editType: "insert",
    form: "next-line",
    after: "// eslint-disable-next-line no-console",
  },
  {
    file: "/repo/a.js",
    line: 2,
    rule: "no-unused-vars",
    editType: "prepend",
    form: "line",
    before: "x // eslint-disable-line no-console",
    after: "x // eslint-disable-line no-unused-vars, no-console",
  },
  {
    file: "/repo/b,quoted.js",
    line: 3,
    rule: 'rule"x',
    editType: "insert",
    form: "next-line",
    after: "line1\nline2",
  },
];

const RUN = buildRunReport(META, EDITS);

const CENSUS: CensusReport = {
  meta: { ...META, action: "inventory", dryRun: false },
  totals: [
    { form: "next-line", rule: "no-console", count: 2 },
    { form: "next-line", rule: null, count: 1 },
    { form: "line", rule: "no-unused-vars", count: 1 },
    { form: "file-level", rule: null, count: 1 },
  ],
  byFile: [
    { file: "/repo/a.js", count: 3 },
    { file: "/repo/b.js", count: 2 },
  ],
};

/** A writable that keeps everything written to it. */
class Capture extends Writable {
  private chunks: string[] = [];
  override _write(chunk: unknown, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    cb();
  }
  text(): string {
    return this.chunks.join("");
  }
}

// --- renderJson ---------------------------------------------------------------

test("renderJson round-trips the canonical run report", () => {
  const parsed = JSON.parse(renderJson(RUN)) as typeof RUN;
  assert.deepEqual(parsed, RUN);
  assert.deepEqual(parsed.meta, META, "full run metadata is carried");
  assert.equal(parsed.edits.length, 3);
  assert.deepEqual(parsed.byRule, RUN.byRule);
  assert.deepEqual(parsed.byForm, RUN.byForm);
  assert.deepEqual(parsed.byFile, RUN.byFile);
});

test("renderJson(false) is a single compact line", () => {
  const compact = renderJson(RUN, false);
  assert.equal(compact.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(compact), RUN);
});

// --- renderCsv ----------------------------------------------------------------

test("renderCsv emits a header and one RFC-4180-quoted row per edit", () => {
  const csv = renderCsv(RUN);
  const expected =
    "file,line,rule,editType,form,before,after\n" +
    "/repo/a.js,1,no-console,insert,next-line,,// eslint-disable-next-line no-console\n" +
    '/repo/a.js,2,no-unused-vars,prepend,line,x // eslint-disable-line no-console,"x // eslint-disable-line no-unused-vars, no-console"\n' +
    '"/repo/b,quoted.js",3,"rule""x",insert,next-line,,"line1\nline2"\n';
  assert.equal(csv, expected);
});

test("renderCsv census rows are one per (form, rule) total, bare rule empty", () => {
  const csv = renderCsv(CENSUS);
  const expected =
    "form,rule,count\n" +
    "next-line,no-console,2\n" +
    "next-line,,1\n" +
    "line,no-unused-vars,1\n" +
    "file-level,,1\n";
  assert.equal(csv, expected);
});

// --- renderHtml ---------------------------------------------------------------

test("renderHtml is a single self-contained file with no external assets", () => {
  const html = renderHtml(RUN);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<style>/, "CSS is inline");
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /\bsrc\s*=/i);
  assert.doesNotMatch(html, /\bhref\s*=/i);
});

test("renderHtml carries the run summary, rollups and per-file drill-down", () => {
  const html = renderHtml(RUN);
  assert.match(html, /Run summary/);
  assert.match(html, /suppress/);
  assert.match(html, /9f2c0a/, "the config sha256 is in the summary");
  assert.match(html, /\/repo\/target/, "the target is in the summary");
  assert.match(html, /3 discovered/, "counts are in the summary");
  assert.match(html, /no-unused-vars/);
  assert.match(html, /no-console/);
  // One <details> per file, keyed by the file path.
  assert.match(html, /<details><summary>\/repo\/a\.js/);
  assert.match(html, /<details><summary>\/repo\/b,quoted\.js/);
});

test("renderHtml escapes ledger text so no raw markup can leak", () => {
  const report = buildRunReport(META, [
    {
      file: "/repo/x<script>.js",
      line: 1,
      rule: "no-console",
      editType: "insert",
      form: "next-line",
      after: "<script>alert(1)</script>",
    },
  ]);
  const html = renderHtml(report);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /x<script>/);
});

test("renderHtml renders a census in the same frame", () => {
  const html = renderHtml(CENSUS);
  assert.match(html, /inventory/);
  assert.match(html, /9f2c0a/);
  assert.match(html, /next-line/);
  assert.match(html, /<details><summary>\/repo\/a\.js/);
  assert.doesNotMatch(html, /\bsrc\s*=/i);
  assert.doesNotMatch(html, /\bhref\s*=/i);
});

// --- resolveReportOptions / emitReport ----------------------------------------

test("resolveReportOptions defaults to html in the cwd", () => {
  const cwd = "/work";
  assert.deepEqual(resolveReportOptions({ cwd }), {
    enabled: true,
    format: "html",
    out: join(cwd, "pocket-comb-report.html"),
  });
  assert.equal(defaultReportPath(cwd, "json"), join(cwd, "pocket-comb-report.json"));
});

test("resolveReportOptions: flag > setting > default, and --out - is stdout", () => {
  const setting = { format: "csv" as const, out: "from-setting.csv" };
  assert.deepEqual(resolveReportOptions({ cwd: "/work", setting }), {
    enabled: true,
    format: "csv",
    out: "/work/from-setting.csv",
  });
  assert.deepEqual(resolveReportOptions({ cwd: "/work", setting, formatFlag: "json" }), {
    enabled: true,
    format: "json",
    out: "/work/from-setting.csv",
  });
  assert.deepEqual(resolveReportOptions({ cwd: "/work", setting, outFlag: "-" }), {
    enabled: true,
    format: "csv",
    out: "-",
  });
  assert.equal(resolveReportOptions({ cwd: "/work", noReport: true }).enabled, false);
});

test("emitReport streams to stdout for '-', and writes/clobbers a file otherwise", () => {
  const out = new Capture();
  const streamed = emitReport({ data: RUN, format: "json", out: "-", stdout: out });
  assert.equal(streamed.path, null);
  assert.deepEqual(JSON.parse(out.text()), RUN);

  const dir = tempDir();
  const target = join(dir, "report.csv");
  const first = emitReport({ data: RUN, format: "csv", out: target, stdout: new Capture() });
  assert.equal(first.path, target);
  assert.equal(readFileSync(target, "utf8"), renderCsv(RUN));

  emitReport({ data: CENSUS, format: "csv", out: target, stdout: new Capture() });
  assert.equal(readFileSync(target, "utf8"), renderCsv(CENSUS), "the file is clobbered");
});

// --- integration with the suppress action -------------------------------------

const CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-console": "warn", "no-unused-vars": "error" } },
];
`;

interface Fixture {
  dir: string;
  target: string;
}

function fixture(files: Record<string, string>): Fixture {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) write(dir, `target/${name}`, content);
  write(dir, "comb.config.mjs", CONFIG);
  return { dir, target: join(dir, "target") };
}

async function suppress(
  dir: string,
  extra: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo({ cwd: dir });
  const code = await main(
    ["suppress", "-c", "comb.config.mjs", "-t", "target", "--workers", "1", ...extra],
    io.io,
  );
  return { code, out: io.stdout(), err: io.stderr() };
}

function configHash(dir: string): string {
  return createHash("sha256").update(readFileSync(join(dir, "comb.config.mjs"))).digest("hex");
}

test("one suppress dry run emits JSON, CSV and HTML with consistent content", async () => {
  const fix = fixture({
    "a.js": 'console.log("a");\nvar unused = 1;\n',
    "b.js": 'console.log("b");\n',
  });

  const json = await suppress(fix.dir, ["--format", "json", "--out", "report.json"]);
  const csv = await suppress(fix.dir, ["--format", "csv", "--out", "report.csv"]);
  const html = await suppress(fix.dir, ["--format", "html", "--out", "report.html"]);
  for (const run of [json, csv, html]) assert.equal(run.code, 1, "dry-run impact is the CI probe");

  const hash = configHash(fix.dir);
  const parsed = JSON.parse(readFileSync(join(fix.dir, "report.json"), "utf8")) as ReturnType<
    typeof buildRunReport
  >;

  // Full run metadata, including the config sha256.
  assert.equal(parsed.meta.tool, "pocket-comb");
  assert.equal(parsed.meta.version, "0.1.0");
  assert.equal(parsed.meta.action, "suppress");
  assert.equal(parsed.meta.configPath, join(fix.dir, "comb.config.mjs"));
  assert.equal(parsed.meta.configHash, hash);
  assert.equal(parsed.meta.target, fix.target);
  assert.match(parsed.meta.startedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(typeof parsed.meta.durationMs, "number");
  assert.equal(parsed.meta.dryRun, true);
  assert.equal(parsed.meta.workers, 1);
  assert.deepEqual(parsed.meta.counts, { discovered: 2, linted: 2, dropped: 0, touched: 2 });

  // The ledger and rollups.
  assert.equal(parsed.edits.length, 3);
  assert.deepEqual(parsed.byRule, [
    { rule: "no-console", count: 2 },
    { rule: "no-unused-vars", count: 1 },
  ]);
  assert.deepEqual(parsed.byForm, [{ form: "next-line", count: 3 }]);
  assert.deepEqual(parsed.byFile, [
    { file: join(fix.target, "a.js"), count: 2 },
    { file: join(fix.target, "b.js"), count: 1 },
  ]);

  // CSV: header + one row per edit, same count.
  const csvRows = readFileSync(join(fix.dir, "report.csv"), "utf8").trimEnd().split("\n");
  assert.equal(csvRows[0], "file,line,rule,editType,form,before,after");
  assert.equal(csvRows.length, 1 + parsed.edits.length);

  // HTML: same config identity and edit count.
  const htmlText = readFileSync(join(fix.dir, "report.html"), "utf8");
  assert.ok(htmlText.includes(hash), "the sha256 is in the HTML");
  assert.match(htmlText, /3 edits/);
  assert.match(htmlText, /<details><summary>/);
});

test("--out - streams the report to stdout with the human summary on stderr", async () => {
  const fix = fixture({ "a.js": 'console.log("a");\n' });

  const { code, out, err } = await suppress(fix.dir, ["--format", "json", "--out", "-"]);
  assert.equal(code, 1);
  const parsed = JSON.parse(out) as ReturnType<typeof buildRunReport>;
  assert.equal(parsed.edits.length, 1);
  assert.match(err, /Impact: 1 files would change/, "the dry-run summary is on stderr");
  assert.match(err, /^Done:/m);
  assert.doesNotMatch(out, /Impact:/, "stdout carries only the report");
});

test("the default filename lands in cwd and is clobbered per run", async () => {
  const fix = fixture({ "a.js": 'console.log("a");\n' });
  const path = join(fix.dir, "pocket-comb-report.html");
  assert.equal(existsSync(path), false);

  await suppress(fix.dir, ["--reason", "first"]);
  assert.equal(existsSync(path), true);
  const first = readFileSync(path, "utf8");
  assert.match(first, /first/);

  await suppress(fix.dir, ["--reason", "second"]);
  const second = readFileSync(path, "utf8");
  assert.match(second, /second/);
  assert.notEqual(second, first, "the default report is clobbered, not appended");
});

test("--no-report skips the report entirely", async () => {
  const fix = fixture({ "a.js": 'console.log("a");\n' });

  const { out } = await suppress(fix.dir, ["--no-report"]);
  assert.equal(existsSync(join(fix.dir, "pocket-comb-report.html")), false);
  assert.doesNotMatch(out, /<!doctype/i);
});
