import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cleanupTemps, runBin, tempDir, write } from "./harness.js";

after(cleanupTemps);

test("the built bin answers --version", () => {
  const result = runBin(["--version"], { cwd: tempDir() });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "0.1.0");
});

test("the built bin answers --help", () => {
  const result = runBin(["--help"], { cwd: tempDir() });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage/);
});

test("the built bin exits 2 on an unknown verb", () => {
  const result = runBin(["bogus"], { cwd: tempDir() });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /bogus/);
});

test("the built bin runs an action against an auto-detected config", () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.mjs", `export default [{ rules: {} }];\n`);
  const result = runBin(["inventory"], { cwd: dir });
  assert.equal(result.status, 0);
});
