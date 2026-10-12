import { test, after } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/cli.js";
import { cleanupTemps, fakeIo, tempDir, write } from "./harness.js";
import type { MainDeps } from "../src/cli.js";
import type { Prompter } from "../src/wizard.js";

after(cleanupTemps);

async function run(
  argv: string[],
  dir: string,
  tty = false,
  deps: MainDeps = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo({ cwd: dir, tty });
  const code = await main(argv, io.io, deps);
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

test("replace with a settings pair runs the action (no longer a placeholder)", async () => {
  const dir = tempDir();
  write(
    dir,
    "pocket-comb.config.mjs",
    `export default [{ rules: {}, settings: { "pocket-comb": { replace: { from: "a", to: "b" } } } }];\n`,
  );
  const { code, err } = await run(["replace"], dir);
  assert.equal(code, 0, "a settings-carried pair dispatches to the action; nothing matched here");
  assert.doesNotMatch(err, /not implemented/);
});

test("non-TTY replace without a pair exits 2 listing exactly --from and --to", async () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.mjs", BASIC_CONFIG);
  const { code, err } = await run(["replace"], dir, false);
  assert.equal(code, 2);
  assert.match(err, /--from/);
  assert.match(err, /--to/);
});

test("a TTY replace without a pair is filled by the wizard", async () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.mjs", BASIC_CONFIG);
  const texts = ["old/rule", "new/rule"];
  const confirms = [true];
  const prompter: Prompter = {
    intro() {},
    outro() {},
    cancel() {},
    select: async () => "abort",
    text: async () => texts.shift()!,
    confirm: async () => confirms.shift()!,
    path: async () => dir,
  };
  const { code, err } = await run(
    ["replace", "--config", "pocket-comb.config.mjs", "--target", ".", "--no-report"],
    dir,
    true,
    { prompter },
  );
  assert.equal(code, 0, "the wizard fills the pair and runs replace");
  assert.doesNotMatch(err, /not implemented/);
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

test("inventory is wired: a census exits 0", async () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.mjs", BASIC_CONFIG);
  const { code, err } = await run(["inventory"], dir);
  assert.equal(code, 0);
  assert.equal(err, "");
});
