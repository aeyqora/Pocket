import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createIsolatedESLint } from "../src/eslint.js";
import { runBatch } from "../src/engine.js";
import { cleanupTemps, tempDir, write } from "./harness.js";

after(cleanupTemps);

/** `no-var` and `prefer-const` are both auto-fixable, and their fixes chain. */
const FIX_CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-var": "warn", "prefer-const": "warn" } },
];
`;

test("a fix dry run plans the fixed text and never writes", async () => {
  const dir = tempDir();
  const target = join(dir, "target");
  const dirty = write(dir, "target/dirty.js", "var x = 1;\n");
  const configPath = write(dir, "comb.config.mjs", FIX_CONFIG);
  const eslint = createIsolatedESLint({ configPath, cwd: target, fix: true });

  const { outcomes } = await runBatch(eslint, [dirty], {
    action: "fix",
    params: {},
    mode: "dry-run",
  });

  const outcome = outcomes[0]!;
  assert.equal(outcome.changed, true);
  assert.equal(outcome.output, "const x = 1;\n", "the planned text is the converged fix");
  assert.equal(readFileSync(dirty, "utf8"), "var x = 1;\n", "a dry run never writes");
  assert.equal(outcome.edits.length, 1, "one fix ledger record per changed file");
  assert.equal(outcome.edits[0]?.editType, "fix");
  assert.equal(outcome.edits[0]?.form, null);
  assert.equal(outcome.stats.wouldFix, 1);
});

test("a fix apply writes via ESLint.outputFixes, not the engine's writer", async () => {
  const dir = tempDir();
  const target = join(dir, "target");
  const dirty = write(dir, "target/dirty.js", "var x = 1;\n");
  const configPath = write(dir, "comb.config.mjs", FIX_CONFIG);
  const eslint = createIsolatedESLint({ configPath, cwd: target, fix: true });

  const { outcomes } = await runBatch(eslint, [dirty], {
    action: "fix",
    params: {},
    mode: "apply",
  });

  assert.equal(outcomes[0]?.changed, true);
  assert.equal(outcomes[0]?.output, undefined, "the text lives on disk, not the wire");
  assert.equal(readFileSync(dirty, "utf8"), "const x = 1;\n");
});

test("a clean file is never a fix outcome", async () => {
  const dir = tempDir();
  const target = join(dir, "target");
  const clean = write(dir, "target/clean.js", "const x = 1;\n");
  const configPath = write(dir, "comb.config.mjs", FIX_CONFIG);
  const eslint = createIsolatedESLint({ configPath, cwd: target, fix: true });

  const { outcomes } = await runBatch(eslint, [clean], {
    action: "fix",
    params: {},
    mode: "apply",
  });

  assert.equal(outcomes[0]?.changed, false);
  assert.deepEqual(outcomes[0]?.edits, []);
  assert.equal(outcomes[0]?.stats.wouldFix, 0);
});

test("the fix path calls ESLint exactly once: convergence is ESLint's 10-pass loop", async () => {
  const dir = tempDir();
  const target = join(dir, "target");
  // `var` -> `let` (no-var) -> `const` (prefer-const): two internal fix passes.
  const dirty = write(dir, "target/dirty.js", "var x = 1;\n");
  const configPath = write(dir, "comb.config.mjs", FIX_CONFIG);
  const eslint = createIsolatedESLint({ configPath, cwd: target, fix: true });

  let calls = 0;
  const original = eslint.lintFiles.bind(eslint);
  eslint.lintFiles = async (patterns: string | string[]) => {
    calls += 1;
    return original(patterns);
  };

  await runBatch(eslint, [dirty], { action: "fix", params: {}, mode: "apply" });

  assert.equal(calls, 1, "the tool never re-runs lintFiles to reach convergence");
  assert.equal(
    readFileSync(dirty, "utf8"),
    "const x = 1;\n",
    "ESLint converged both passes internally",
  );
});
