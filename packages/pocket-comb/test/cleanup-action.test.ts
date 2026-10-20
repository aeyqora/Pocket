import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { cleanupTemps, fakeIo, tempDir, write } from "./harness.js";

after(cleanupTemps);

/**
 * Both severities actionable, scoped to the target's JS files so the action
 * config itself is never linted. The config's rules are exactly what cleanup is
 * allowed to prune: an unused directive naming a rule outside this set must stay.
 */
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
  for (const [name, content] of Object.entries(files)) {
    write(dir, `target/${name}`, content);
  }
  write(dir, "comb.config.mjs", CONFIG);
  return { dir, target: join(dir, "target") };
}

async function cleanup(
  dir: string,
  extra: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo({ cwd: dir });
  const code = await main(
    ["cleanup", "-c", "comb.config.mjs", "-t", "target", "--workers", "1", ...extra],
    io.io,
  );
  return { code, out: io.stdout(), err: io.stderr() };
}

test("a dry run prunes a single-rule unused directive (delete whole) and exits 1", async () => {
  const fix = fixture({ "a.js": "// eslint-disable-next-line no-console\ndoThing();\n" });

  const { code, out } = await cleanup(fix.dir);
  assert.equal(code, 1, "dry-run impact is the CI probe");

  const [headline, byType, byRule, done] = out.split("\n");
  assert.equal(headline, "Impact: 1 files would change, 1 edits (0 inserted, 0 prepended)");
  assert.equal(byType, "  by type: prune 1");
  assert.equal(byRule, "  by rule: no-console 1");
  assert.match(done!, /^Done: 1 files touched, 1 edits \(0 inserted, 0 prepended\) — \d+\.\ds$/);

  assert.match(
    readFileSync(join(fix.target, "a.js"), "utf8"),
    /eslint-disable-next-line/,
    "a dry run never writes",
  );
});

test("--apply deletes the fully-unused directive and is idempotent on re-run", async () => {
  const fix = fixture({ "a.js": "// eslint-disable-next-line no-console\ndoThing();\n" });

  const applied = await cleanup(fix.dir, ["--apply"]);
  assert.equal(applied.code, 0);
  assert.equal(readFileSync(join(fix.target, "a.js"), "utf8"), "doThing();\n");

  const rerun = await cleanup(fix.dir);
  assert.equal(rerun.code, 0, "nothing left to prune");
  assert.ok(rerun.out.startsWith("Impact: 0 files would change, 0 edits"));
});

test("a multi-rule directive keeps its still-used rules — surgical strip, not whole deletion", async () => {
  const fix = fixture({
    "a.js": "// eslint-disable-next-line no-console, no-unused-vars\nconsole.log(1);\n",
  });

  const dry = await cleanup(fix.dir);
  assert.equal(dry.code, 1);
  assert.match(dry.out, /by type: prune 1/);
  assert.match(dry.out, /by rule: no-unused-vars 1/);

  await cleanup(fix.dir, ["--apply"]);
  assert.equal(
    readFileSync(join(fix.target, "a.js"), "utf8"),
    "// eslint-disable-next-line no-console\nconsole.log(1);\n",
    "no-console is still used, so it survives; only no-unused-vars is stripped",
  );
});

test("a partially-unused block keeps its surviving rule and its eslint-enable", async () => {
  const fix = fixture({
    "block.js": [
      "/* eslint-disable no-console, no-unused-vars */",
      "console.log(1);",
      "/* eslint-enable no-console, no-unused-vars */",
      "",
    ].join("\n"),
  });

  await cleanup(fix.dir, ["--apply"]);
  assert.equal(
    readFileSync(join(fix.target, "block.js"), "utf8"),
    [
      "/* eslint-disable no-console */",
      "console.log(1);",
      "/* eslint-enable no-console */",
      "",
    ].join("\n"),
    "both sides of the pair lose no-unused-vars; no-console survives on each",
  );

  const rerun = await cleanup(fix.dir);
  assert.equal(rerun.code, 0, "the paired enable is reconciled in the same pass");
  assert.ok(rerun.out.startsWith("Impact: 0 files would change, 0 edits"));
});

test("prunes exactly the config's rules; a non-config unused suppression is untouched", async () => {
  const fix = fixture({
    "corpus.js": [
      "// eslint-disable-next-line no-console, no-unused-vars",
      "console.log(1);",
      "// eslint-disable-next-line no-alert",
      "doThing();",
      "// eslint-disable-next-line no-unused-vars",
      "doThing2();",
      "",
    ].join("\n"),
  });

  await cleanup(fix.dir, ["--apply"]);
  assert.equal(
    readFileSync(join(fix.target, "corpus.js"), "utf8"),
    [
      "// eslint-disable-next-line no-console",
      "console.log(1);",
      "// eslint-disable-next-line no-alert",
      "doThing();",
      "doThing2();",
      "",
    ].join("\n"),
    "no-alert is not the config's to prune; no-unused-vars is stripped/deleted",
  );

  const rerun = await cleanup(fix.dir);
  assert.equal(rerun.code, 0);
  assert.ok(rerun.out.startsWith("Impact: 0 files would change, 0 edits"));
});

test("bare fully-unused directives are deleted whole; unscopable bare ones stay and are reported", async () => {
  const fix = fixture({
    "bare.js": ["/* eslint-disable */", "console.log(1);", "/* eslint-disable */", ""].join("\n"),
  });

  const { code, out } = await cleanup(fix.dir);
  assert.equal(code, 1);
  assert.match(out, /by rule: \* 1/, "a bare deletion is ledgered with the whole-rule-set sentinel");
  assert.match(out, /Not actionable: 1 bare directives \(no rule list\)/);
  assert.match(out, /  target\/bare\.js:1 file-level \/\* eslint-disable \*\//);

  await cleanup(fix.dir, ["--apply"]);
  assert.equal(
    readFileSync(join(fix.target, "bare.js"), "utf8"),
    ["/* eslint-disable */", "console.log(1);", ""].join("\n"),
    "the used bare guard survives; only the unused one is deleted",
  );
});

test("unused eslint-enable directives are removed whole", async () => {
  const fix = fixture({ "enable.js": "/* eslint-enable no-console */\n" });

  await cleanup(fix.dir, ["--apply"]);
  assert.equal(readFileSync(join(fix.target, "enable.js"), "utf8"), "");
});

test("a bare disable and its paired enable are both removed, leaving no orphan", async () => {
  const fix = fixture({ "pair.js": "/* eslint-disable */\n/* eslint-enable */\n" });

  const dry = await cleanup(fix.dir);
  assert.equal(dry.code, 1);
  assert.match(dry.out, /by type: prune 2/, "the open and its stranded closer both ledger");

  await cleanup(fix.dir, ["--apply"]);
  assert.equal(readFileSync(join(fix.target, "pair.js"), "utf8"), "");

  const rerun = await cleanup(fix.dir);
  assert.equal(rerun.code, 0, "no orphaned enable is left for a second pass");
});

test("--format json --out - streams the run report; human output moves to stderr", async () => {
  const fix = fixture({
    "a.js": "// eslint-disable-next-line no-console, no-unused-vars\nconsole.log(1);\n",
  });

  const { code, out, err } = await cleanup(fix.dir, ["--format", "json", "--out", "-"]);
  assert.equal(code, 1);

  const report = JSON.parse(out) as {
    meta: { action: string; dryRun: boolean; configHash: string };
    edits: Array<{ rule: string; editType: string; form: string; after?: string }>;
    byRule: Array<{ rule: string; count: number }>;
  };
  assert.equal(report.meta.action, "cleanup");
  assert.equal(report.meta.dryRun, true);
  assert.equal(report.meta.configHash.length, 64);
  assert.deepEqual(
    report.edits.map((edit) => [edit.rule, edit.editType, edit.form]),
    [["no-unused-vars", "prune", "next-line"]],
  );
  assert.equal(report.edits[0]?.after, "// eslint-disable-next-line no-console");
  assert.deepEqual(report.byRule, [{ rule: "no-unused-vars", count: 1 }]);

  assert.match(err, /Impact: 1 files would change/, "human output moves to stderr for a piped report");
  assert.match(err, /Done: 1 files touched/);
});

test("a target with no matching files is an operational error (exit 2)", async () => {
  const dir = tempDir();
  write(dir, "comb.config.mjs", CONFIG);
  write(dir, "target/readme.md", "nothing to lint here\n");

  const io = fakeIo({ cwd: dir });
  const code = await main(["cleanup", "-c", "comb.config.mjs", "-t", "target"], io.io);
  assert.equal(code, 2);
  assert.match(io.stderr(), /no files matched/);
});
