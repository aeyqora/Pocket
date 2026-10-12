import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { cleanupTemps, fakeIo, tempDir, write } from "./harness.js";

after(cleanupTemps);

/** Both rules are auto-fixable, and their fixes chain (`var` -> `let` -> `const`). */
const CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-var": "warn", "prefer-const": "warn" } },
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

async function fix(
  dir: string,
  extra: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo({ cwd: dir });
  const code = await main(
    ["fix", "-c", "comb.config.mjs", "-t", "target", "--workers", "1", ...extra],
    io.io,
  );
  return { code, out: io.stdout(), err: io.stderr() };
}

test("fix dry run reports the would-fix counts and never writes", async () => {
  const repo = fixture({
    "a.js": "var x = 1;\n",
    "b.js": "var y = 2;\n",
    "clean.js": "const z = 3;\n",
  });

  const { code, out } = await fix(repo.dir);
  assert.equal(code, 1, "a dry run with impact is the CI probe");

  const [headline, byType, byRule, done] = out.split("\n");
  assert.equal(headline, "Impact: 2 files would change, 2 edits (0 inserted, 0 prepended, 2 fixed)");
  assert.equal(byType, "  by type: fix 2");
  assert.equal(byRule, "  by rule: (autofix) 2");
  assert.match(done!, /^Done: 2 files touched, 2 edits \(0 inserted, 0 prepended, 2 fixed\) — \d+\.\ds$/);

  assert.equal(readFileSync(join(repo.target, "a.js"), "utf8"), "var x = 1;\n", "no write");
  assert.equal(readFileSync(join(repo.target, "b.js"), "utf8"), "var y = 2;\n", "no write");
});

test("fix --apply writes the fixes and the completion prints the fixed files", async () => {
  const repo = fixture({
    "a.js": "var x = 1;\n",
    "b.js": "var y = 2;\n",
  });

  const applied = await fix(repo.dir, ["--apply"]);
  assert.equal(applied.code, 0);
  assert.match(applied.out, /^Impact: 2 files changed, 2 edits \(0 inserted, 0 prepended, 2 fixed\)/);
  assert.match(applied.out, /Done: 2 files touched, 2 edits \(0 inserted, 0 prepended, 2 fixed\)/);

  assert.equal(readFileSync(join(repo.target, "a.js"), "utf8"), "const x = 1;\n");
  assert.equal(readFileSync(join(repo.target, "b.js"), "utf8"), "const y = 2;\n");

  const rerun = await fix(repo.dir);
  assert.equal(rerun.code, 0, "nothing left to fix");
  assert.match(rerun.out, /Impact: 0 files would change, 0 edits/);
});

test("fixes come only from the config's rules: the repo's own config is never read", async () => {
  const dir = tempDir();
  const target = join(dir, "target");
  // The repo's OWN config would also fix quotes and semi. The action config
  // enables only no-var, so only no-var may fire.
  write(
    dir,
    "target/eslint.config.js",
    `export default [{ rules: { "no-var": "warn", quotes: "warn", semi: "warn" } }];\n`,
  );
  write(dir, "target/app.js", 'var x = "a"\n');
  write(
    dir,
    "comb.config.mjs",
    `export default [{ files: ["**/*.js"], rules: { "no-var": "warn" } }];\n`,
  );

  const applied = await fix(dir, ["--apply"]);
  assert.equal(applied.code, 0);

  assert.equal(
    readFileSync(join(target, "app.js"), "utf8"),
    'let x = "a"\n',
    "only the config's no-var fix ran; quotes and semi (repo config) did not",
  );
});

test("a target with no matching files is an operational error (exit 2)", async () => {
  const dir = tempDir();
  write(dir, "comb.config.mjs", CONFIG);
  write(dir, "target/readme.md", "nothing\n");

  const io = fakeIo({ cwd: dir });
  const code = await main(["fix", "-c", "comb.config.mjs", "-t", "target"], io.io);
  assert.equal(code, 2);
  assert.match(io.stderr(), /no files matched/);
});

test("--serial fixes in-process with no worker threads", async () => {
  const repo = fixture({ "a.js": "var x = 1;\n" });

  const applied = await fix(repo.dir, ["--apply", "--serial"]);
  assert.equal(applied.code, 0);
  assert.equal(readFileSync(join(repo.target, "a.js"), "utf8"), "const x = 1;\n");
  assert.match(applied.out, /1 fixed/);
});
