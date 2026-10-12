import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { cleanupTemps, fakeIo, tempDir, write } from "./harness.js";
import type { CensusReport } from "../src/report/index.js";

after(cleanupTemps);

const CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-console": "warn", "no-unused-vars": "error" } },
];
`;

interface Fixture {
  dir: string;
  target: string;
}

function fixture(files: Record<string, string>, config = CONFIG): Fixture {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) write(dir, `target/${name}`, content);
  write(dir, "comb.config.mjs", config);
  return { dir, target: join(dir, "target") };
}

async function inventory(
  dir: string,
  extra: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo({ cwd: dir });
  const code = await main(["inventory", "-c", "comb.config.mjs", "-t", "target", ...extra], io.io);
  return { code, out: io.stdout(), err: io.stderr() };
}

/** Parse a census CSV into a `(form, rule) -> count` map (bare rule is `""`). */
function parseCensusCsv(csv: string): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines[0], "form,rule,count", "the census CSV header");
  for (const line of lines.slice(1)) {
    const [form, rule, count] = line.split(",");
    counts.set(`${form}/${rule}`, Number(count));
  }
  return counts;
}

test("a census counts every directive across all four forms, per rule and per file, and exits 0", async () => {
  const fix = fixture({
    "a.js": [
      "/* eslint-disable no-console, no-unused-vars */",
      "const a = 1; // eslint-disable-line no-console",
      "// eslint-disable-next-line no-debugger",
      "debugger;",
      "/* eslint-enable no-console, no-unused-vars */",
      "/* eslint-disable no-alert */",
      "// eslint-disable",
      "",
    ].join("\n"),
    "b.js": ["// eslint-disable-next-line no-console", "console.log(1);", ""].join("\n"),
  });

  const { code, out, err } = await inventory(fix.dir, ["--format", "json", "--out", "-"]);
  assert.equal(code, 0, "a non-error census always exits 0");

  const report = JSON.parse(out) as CensusReport;
  assert.equal(report.meta.tool, "pocket-comb");
  assert.equal(report.meta.action, "inventory");
  assert.equal(report.meta.dryRun, false);
  assert.equal(report.meta.counts.discovered, 2);
  assert.equal(report.meta.counts.linted, 0, "inventory never lints");

  // Form canonical order, then rule alphabetical, bare last.
  assert.deepEqual(report.totals, [
    { form: "next-line", rule: "no-console", count: 1 },
    { form: "next-line", rule: "no-debugger", count: 1 },
    { form: "line", rule: "no-console", count: 1 },
    { form: "block", rule: "no-console", count: 1 },
    { form: "block", rule: "no-unused-vars", count: 1 },
    { form: "file-level", rule: "no-alert", count: 1 },
    { form: "file-level", rule: null, count: 1 },
  ]);

  assert.deepEqual(report.byFile, [
    { file: join(fix.target, "a.js"), count: 5 },
    { file: join(fix.target, "b.js"), count: 1 },
  ]);

  // `--out -` moves the human census line to stderr, keeping stdout pure JSON.
  assert.match(err, /^Census: 6 directives in 2 files /m);
  assert.doesNotMatch(out, /Census:/);
});

test("the eslint-enable entries are not counted (only disables are suppressions)", async () => {
  const fix = fixture({
    "pair.js": ["/* eslint-disable no-console */", "foo();", "/* eslint-enable no-console */", ""].join("\n"),
  });

  const { out } = await inventory(fix.dir, ["--format", "json", "--out", "-"]);
  const report = JSON.parse(out) as CensusReport;
  assert.deepEqual(report.totals, [{ form: "block", rule: "no-console", count: 1 }]);
});

test("ordering is stable: two censuses of an unchanged repo are byte-identical", async () => {
  const fix = fixture({
    "b.js": "// eslint-disable-next-line no-console\n",
    "a.js": "// eslint-disable-next-line no-console, no-debugger\n/* eslint-disable */\n",
  });

  const first = await inventory(fix.dir, ["--format", "csv", "--out", "-"]);
  const second = await inventory(fix.dir, ["--format", "csv", "--out", "-"]);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(second.out, first.out, "byte-identical CSV across runs");
  assert.ok(first.out.startsWith("form,rule,count\n"), "the piping header row");
});

test("a mutate-then-recount cycle reflects the delta exactly (the trend mechanism)", async () => {
  const fix = fixture({
    "a.js": [
      "// eslint-disable-next-line no-console",
      "// eslint-disable-next-line no-alert",
      "",
    ].join("\n"),
  });

  const before = parseCensusCsv((await inventory(fix.dir, ["--format", "csv", "--out", "-"])).out);
  assert.deepEqual(
    [...before.entries()].sort(),
    [
      ["next-line/no-alert", 1],
      ["next-line/no-console", 1],
    ],
    "the starting census",
  );

  // Mutate with ticket 09's remove: strip the config's `no-console` directive.
  const io = fakeIo({ cwd: fix.dir });
  const removeCode = await main(
    ["remove", "-c", "comb.config.mjs", "-t", "target", "--workers", "1", "--apply", "--no-report"],
    io.io,
  );
  assert.equal(removeCode, 0);

  const after = parseCensusCsv((await inventory(fix.dir, ["--format", "csv", "--out", "-"])).out);
  const delta = new Map<string, number>();
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    delta.set(key, (after.get(key) ?? 0) - (before.get(key) ?? 0));
  }

  // Exactly one suppression gone; nothing else moved.
  assert.deepEqual(
    [...delta.entries()].filter(([, value]) => value !== 0).sort(),
    [["next-line/no-console", -1]],
  );
});

test("--format csv --out - pipes cleanly to stdout with the census line on stderr", async () => {
  const fix = fixture({ "a.js": "// eslint-disable-next-line no-console\n" });

  const { code, out, err } = await inventory(fix.dir, ["--format", "csv", "--out", "-"]);
  assert.equal(code, 0);
  assert.equal(out, "form,rule,count\nnext-line,no-console,1\n", "stdout is exactly the CSV");
  assert.match(err, /^Census: 1 directives in 1 files /m);
});

test("no lint pass runs: a census succeeds on a config ESLint cannot use, where a linting action fails", async () => {
  // A parser ESLint cannot resolve makes any lint pass fail at instance/parse
  // time. Inventory never constructs ESLint, so it still counts the directive.
  const unusable = `export default [
    { files: ["**/*.js"], languageOptions: { parser: "definitely-not-a-real-parser" }, rules: { "no-console": "warn" } },
  ];
  `;
  const fix = fixture({ "a.js": "// eslint-disable-next-line no-console\nconsole.log(1);\n" }, unusable);

  const census = await inventory(fix.dir, ["--format", "json", "--out", "-"]);
  assert.equal(census.code, 0, "inventory does not need ESLint to run");
  const report = JSON.parse(census.out) as CensusReport;
  assert.deepEqual(report.totals, [{ form: "next-line", rule: "no-console", count: 1 }]);

  // The same config genuinely defeats a linting action, proving the census
  // bypassed the lint pool rather than silently tolerating a broken instance.
  const io = fakeIo({ cwd: fix.dir });
  const suppressCode = await main(
    ["suppress", "-c", "comb.config.mjs", "-t", "target", "--workers", "1", "--no-report"],
    io.io,
  );
  assert.equal(suppressCode, 2, "the linting action cannot use the config");
});

test("no lint pass runs: a census counts directives in a file ESLint could not parse", async () => {
  const fix = fixture({ "broken.js": "// eslint-disable-next-line no-console\nconst = ;\n" });

  const { code, out } = await inventory(fix.dir, ["--format", "json", "--out", "-"]);
  assert.equal(code, 0);
  const report = JSON.parse(out) as CensusReport;
  assert.deepEqual(report.totals, [{ form: "next-line", rule: "no-console", count: 1 }]);
});

test("no lint pass runs: a census is much faster than a linting action on the same corpus", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i++) {
    files[`f${i}.js`] = `// eslint-disable-next-line no-console\nconsole.log(${i});\n`;
  }
  const fix = fixture(files);

  const inventoryStart = Date.now();
  const census = await inventory(fix.dir, ["--format", "csv", "--out", "-"]);
  const inventoryMs = Date.now() - inventoryStart;
  assert.equal(census.code, 0);

  const io = fakeIo({ cwd: fix.dir });
  const suppressStart = Date.now();
  await main(
    ["suppress", "-c", "comb.config.mjs", "-t", "target", "--workers", "1", "--no-report"],
    io.io,
  );
  const suppressMs = Date.now() - suppressStart;

  // The linting action boots a worker + ESLint and lints; the census only walks
  // and scans. The gap is large; assert it is at least 2x so contention cannot
  // flip the sign.
  assert.ok(
    inventoryMs * 2 < suppressMs,
    `inventory (${inventoryMs}ms) should be far faster than suppress (${suppressMs}ms)`,
  );
});

test("the default report file lands in the cwd and renders the census", async () => {
  const fix = fixture({ "a.js": "// eslint-disable-next-line no-console\n" });
  const reportPath = join(fix.dir, "pocket-comb-report.html");
  assert.equal(existsSync(reportPath), false);

  const { code } = await inventory(fix.dir);
  assert.equal(code, 0);
  const html = readFileSync(reportPath, "utf8");
  assert.match(html, /inventory/);
  assert.match(html, /next-line/);
});

test("a target with no matching files is an operational error (exit 2)", async () => {
  const dir = tempDir();
  write(dir, "comb.config.mjs", CONFIG);
  write(dir, "target/readme.md", "nothing to scan here\n");

  const io = fakeIo({ cwd: dir });
  const code = await main(["inventory", "-c", "comb.config.mjs", "-t", "target"], io.io);
  assert.equal(code, 2);
  assert.match(io.stderr(), /no files matched/);
});
