import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { runPool } from "../src/pool.js";
import { cleanupTemps, fakeIo, tempDir, write } from "./harness.js";

after(cleanupTemps);

/** `no-var` is auto-fixable; `no-debugger` is not, so it must be suppressed. */
const CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-var": "warn", "no-debugger": "warn" } },
];
`;

interface Fixture {
  dir: string;
  target: string;
}

function fixture(files: Record<string, string>, config = CONFIG): Fixture {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) {
    write(dir, `target/${name}`, content);
  }
  write(dir, "comb.config.mjs", config);
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

test("--fix-first fixes the fixable, suppresses only the remainder, in one run", async () => {
  const repo = fixture({ "a.js": "var x = 1;\ndebugger;\n" });

  const applied = await suppress(repo.dir, ["--fix-first", "--apply"]);
  assert.equal(applied.code, 0);

  assert.equal(
    readFileSync(join(repo.target, "a.js"), "utf8"),
    "let x = 1;\n// eslint-disable-next-line no-debugger\ndebugger;\n",
    "the fixable var was fixed and only the remainder was suppressed",
  );

  // One ledgered run: a single impact summary and a single completion line, with
  // both the fix edit and the suppress edit accounted for.
  assert.equal(applied.out.match(/^Impact:/gm)?.length, 1, "one impact summary");
  assert.match(applied.out, /1 files changed, 2 edits \(1 inserted, 0 prepended, 1 fixed\)/);
  assert.match(applied.out, /Done: 1 files touched, 2 edits \(1 inserted, 0 prepended, 1 fixed\)/);
  assert.match(applied.out, /by type: insert 1, fix 1/);
});

test("the suppress re-lint reads the fixed files from disk", async () => {
  // `no-var` is the only rule; fixing it removes the only violation. A stale
  // re-lint (the pre-fix text) would still suppress no-var and add a directive.
  const onlyNoVar = `export default [{ files: ["**/*.js"], rules: { "no-var": "warn" } }];\n`;
  const repo = fixture({ "a.js": "var x = 1;\n" }, onlyNoVar);

  const applied = await suppress(repo.dir, ["--fix-first", "--apply"]);
  assert.equal(applied.code, 0);

  assert.equal(
    readFileSync(join(repo.target, "a.js"), "utf8"),
    "let x = 1;\n",
    "the re-lint saw the fixed text, so nothing was suppressed",
  );
  assert.doesNotMatch(applied.out, /inserted 1/, "no suppress edit was ledgered");
  assert.match(applied.out, /1 fixed/, "the fix phase is reported");
});

test("--fix-first dry run reports the combined impact and never writes", async () => {
  const repo = fixture({ "a.js": "var x = 1;\ndebugger;\n" });

  const dry = await suppress(repo.dir, ["--fix-first"]);
  assert.equal(dry.code, 1, "dry-run impact is the CI probe");

  assert.match(dry.out, /^Impact: 1 files would change, 2 edits \(1 inserted, 0 prepended, 1 fixed\)/);
  assert.equal(
    readFileSync(join(repo.target, "a.js"), "utf8"),
    "var x = 1;\ndebugger;\n",
    "a dry run never writes the fix or the suppression",
  );
});

test("--fix-first --serial runs the two phases in-process", async () => {
  const repo = fixture({ "a.js": "var x = 1;\ndebugger;\n" });

  const applied = await suppress(repo.dir, ["--fix-first", "--apply", "--serial"]);
  assert.equal(applied.code, 0);
  assert.equal(
    readFileSync(join(repo.target, "a.js"), "utf8"),
    "let x = 1;\n// eslint-disable-next-line no-debugger\ndebugger;\n",
  );
});

test("--fix-first builds a second, fix-enabled instance per worker", async () => {
  const repo = fixture({ "a.js": "var x = 1;\ndebugger;\n" });

  const result = await runPool({
    files: [join(repo.target, "a.js")],
    configPath: join(repo.dir, "comb.config.mjs"),
    cwd: repo.target,
    action: "suppress",
    params: {},
    mode: "apply",
    workers: 1,
    fixFirst: true,
  });

  assert.equal(result.workerStats.length, 1);
  assert.equal(
    result.workerStats[0]?.constructed,
    2,
    "one non-fix instance for suppress, one fix-enabled instance for the fix phase",
  );
});
