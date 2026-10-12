import { test, after } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.js";
import { cleanupTemps, fakeIo, tempDir, write } from "./harness.js";

after(cleanupTemps);

async function run(argv: string[], dir: string, tty = false): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo({ cwd: dir, tty });
  const code = await main(argv, io.io);
  return { code, out: io.stdout(), err: io.stderr() };
}

const BASIC_CONFIG = `export default [{ rules: { "no-console": "warn" } }];\n`;

test("--help prints usage and exits 0", async () => {
  const { code, out } = await run(["--help"], tempDir());
  assert.equal(code, 0);
  assert.match(out, /Usage/);
});

test("--version prints the version and exits 0", async () => {
  const { code, out } = await run(["--version"], tempDir());
  assert.equal(code, 0);
  assert.equal(out.trim(), "0.1.0");
});

test("an unknown verb exits 2", async () => {
  const { code, err } = await run(["bogus"], tempDir());
  assert.equal(code, 2);
  assert.match(err, /bogus/);
});

test("an unknown flag exits 2", async () => {
  const { code, err } = await run(["suppress", "--nope"], tempDir());
  assert.equal(code, 2);
  assert.match(err, /--nope/);
});

test("a missing action exits 2 naming the actions", async () => {
  const { code, err } = await run([], tempDir());
  assert.equal(code, 2);
  assert.match(err, /missing action/);
});

test("a valid auto-detected config runs the action to success", async () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.mjs", BASIC_CONFIG);
  const { code, err } = await run(["suppress"], dir);
  assert.equal(code, 0);
  assert.equal(err, "");
});

test("replace with a settings pair runs non-interactively", async () => {
  const dir = tempDir();
  write(
    dir,
    "pocket-comb.config.mjs",
    `export default [{ rules: {}, settings: { "pocket-comb": { replace: { from: "a", to: "b" } } } }];\n`,
  );
  const { code } = await run(["replace"], dir);
  assert.equal(code, 0);
});

test("non-TTY replace without a pair exits 2 listing exactly --from and --to", async () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.mjs", BASIC_CONFIG);
  const { code, err } = await run(["replace"], dir, false);
  assert.equal(code, 2);
  assert.match(err, /--from/);
  assert.match(err, /--to/);
});

test("a TTY replace without a pair does not error (a wizard would fill the gap)", async () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.mjs", BASIC_CONFIG);
  const { code } = await run(["replace"], dir, true);
  assert.equal(code, 0);
});

test("a missing config exits 2 with a message naming --config", async () => {
  const { code, err } = await run(["suppress"], tempDir());
  assert.equal(code, 2);
  assert.match(err, /--config/);
});

test("an unloadable config exits 2", async () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.mjs", "export default [ oops\n");
  const { code, err } = await run(["suppress"], dir);
  assert.equal(code, 2);
  assert.match(err, /pocket-comb\.config\.mjs/);
});

test("inventory runs non-interactively off the auto-detected config", async () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.mjs", BASIC_CONFIG);
  const { code } = await run(["inventory"], dir);
  assert.equal(code, 0);
});
