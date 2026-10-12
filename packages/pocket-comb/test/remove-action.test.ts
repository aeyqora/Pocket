import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { cleanupTemps, fakeIo, tempDir, write } from "./harness.js";

after(cleanupTemps);

/**
 * Both severities actionable, scoped to the target's JS files so the action
 * config itself is never linted. The config's rules are exactly what remove
 * strips.
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

async function remove(
  dir: string,
  extra: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo({ cwd: dir });
  const code = await main(
    ["remove", "-c", "comb.config.mjs", "-t", "target", "--workers", "1", ...extra],
    io.io,
  );
  return { code, out: io.stdout(), err: io.stderr() };
}

test("a dry run prints the exact impact (strips across all four forms) and exits 1", async () => {
  const fix = fixture({
    "a.js": [
      "/* eslint-disable no-console, no-unused-vars */",
      "const a = 1; // eslint-disable-line no-console, no-alert",
      "// eslint-disable-next-line no-console",
      "console.log(a);",
      "/* eslint-enable no-console, no-unused-vars */",
      "",
    ].join("\n"),
  });

  const { code, out } = await remove(fix.dir);
  assert.equal(code, 1, "dry-run impact is the CI probe");

  const [headline, byType, byRule, done] = out.split("\n");
  assert.equal(headline, "Impact: 1 files would change, 6 edits (0 inserted, 0 prepended)");
  assert.equal(byType, "  by type: strip 6");
  assert.equal(byRule, "  by rule: no-console 4, no-unused-vars 2");
  assert.match(done!, /^Done: 1 files touched, 6 edits \(0 inserted, 0 prepended\) — \d+\.\ds$/);

  assert.match(
    readFileSync(join(fix.target, "a.js"), "utf8"),
    /eslint-disable no-console/,
    "a dry run never writes",
  );
});

test("--apply strips the directives and is idempotent on re-run", async () => {
  const fix = fixture({
    "a.js": [
      "/* eslint-disable no-console, no-unused-vars */",
      "const a = 1; // eslint-disable-line no-console, no-alert",
      "// eslint-disable-next-line no-console",
      "console.log(a);",
      "/* eslint-enable no-console, no-unused-vars */",
      "",
    ].join("\n"),
  });

  const applied = await remove(fix.dir, ["--apply"]);
  assert.equal(applied.code, 0);
  assert.equal(
    readFileSync(join(fix.target, "a.js"), "utf8"),
    ["const a = 1; // eslint-disable-line no-alert", "console.log(a);", ""].join("\n"),
    "config rules gone, non-config rules and the code kept",
  );

  const rerun = await remove(fix.dir);
  assert.equal(rerun.code, 0, "nothing left to remove");
  assert.ok(rerun.out.startsWith("Impact: 0 files would change, 0 edits"));
});

test("a block-open that empties takes its paired eslint-enable with it", async () => {
  const fix = fixture({
    "pair.js": ["/* eslint-disable no-console */", "foo();", "/* eslint-enable no-console */", ""].join("\n"),
  });

  const dry = await remove(fix.dir);
  assert.equal(dry.code, 1);
  assert.match(dry.out, /by type: strip 2/, "the open and its closer both ledger");

  await remove(fix.dir, ["--apply"]);
  assert.equal(readFileSync(join(fix.target, "pair.js"), "utf8"), "foo();\n");
});

test("bare directives are untouched and listed as not-actionable", async () => {
  const fix = fixture({
    "bare.js": ["// eslint-disable-next-line", "/* eslint-disable */", "code();", ""].join("\n"),
  });

  const { code, out } = await remove(fix.dir);
  assert.equal(code, 0, "no actionable directives, so no impact");
  assert.match(out, /Not actionable: 2 bare directives \(no rule list\)/);
  assert.match(out, /  target\/bare\.js:1 next-line \/\/ eslint-disable-next-line/);
  assert.match(out, /  target\/bare\.js:2 file-level \/\* eslint-disable \*\//);

  assert.equal(
    readFileSync(join(fix.target, "bare.js"), "utf8"),
    ["// eslint-disable-next-line", "/* eslint-disable */", "code();", ""].join("\n"),
  );
});

test("an emptied line-form directive loses only its comment, not the code", async () => {
  const fix = fixture({ "suffix.js": "const a = 1; // eslint-disable-line no-console\n" });

  await remove(fix.dir, ["--apply"]);
  assert.equal(
    readFileSync(join(fix.target, "suffix.js"), "utf8"),
    "const a = 1;\n",
    "the code survives; only the emptied comment is deleted",
  );
});

test("remove never leaves a bare eslint-disable behind", async () => {
  const fix = fixture({ "single.js": "// eslint-disable-next-line no-console\ncode();\n" });

  await remove(fix.dir, ["--apply"]);
  assert.equal(readFileSync(join(fix.target, "single.js"), "utf8"), "code();\n");
});

test("--format json --out - streams the run report to stdout; human output moves to stderr", async () => {
  const fix = fixture({ "a.js": "// eslint-disable-next-line no-console, no-alert\ncode();\n" });

  const { code, out, err } = await remove(fix.dir, ["--format", "json", "--out", "-"]);
  assert.equal(code, 1);

  const report = JSON.parse(out) as {
    meta: { action: string; dryRun: boolean; configHash: string };
    edits: Array<{ rule: string; editType: string; form: string }>;
    byRule: Array<{ rule: string; count: number }>;
  };
  assert.equal(report.meta.action, "remove");
  assert.equal(report.meta.dryRun, true);
  assert.equal(report.meta.configHash.length, 64);
  assert.deepEqual(
    report.edits.map((edit) => [edit.rule, edit.editType, edit.form]),
    [["no-console", "strip", "next-line"]],
  );
  assert.deepEqual(report.byRule, [{ rule: "no-console", count: 1 }]);

  assert.match(err, /Impact: 1 files would change/, "human output moves to stderr for a piped report");
  assert.match(err, /Done: 1 files touched/);
});

test("a target with no matching files is an operational error (exit 2)", async () => {
  const dir = tempDir();
  write(dir, "comb.config.mjs", CONFIG);
  write(dir, "target/readme.md", "nothing to lint here\n");

  const io = fakeIo({ cwd: dir });
  const code = await main(["remove", "-c", "comb.config.mjs", "-t", "target"], io.io);
  assert.equal(code, 2);
  assert.match(io.stderr(), /no files matched/);
});
