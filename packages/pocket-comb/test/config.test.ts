import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadConfig,
  autoDetectConfig,
  isActionableRule,
  type LoadedConfig,
} from "../src/config.js";
import { ConfigError, isOperationalError } from "../src/errors.js";
import { cleanupTemps, tempDir, write } from "./harness.js";

after(cleanupTemps);

async function expectConfigError(promise: Promise<unknown>): Promise<ConfigError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(isOperationalError(err), `expected operational error, got ${String(err)}`);
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${String(err)}`);
    return err;
  }
  throw new Error("expected the load to fail");
}

test("a valid JSON config loads rules as membership and reads the settings block", async () => {
  const dir = tempDir();
  const body =
    JSON.stringify([
      {
        files: ["**/*.js"],
        rules: {
          "no-console": "warn",
          "no-debugger": "error",
          "no-alert": "off",
          eqeqeq: 0,
          semi: ["error", "always"],
          quotes: ["off"],
        },
        settings: {
          "pocket-comb": {
            target: "../src",
            replace: { from: "old", to: "new" },
            report: { format: "csv", out: "out.csv" },
          },
        },
      },
    ]) + "\n";
  const path = write(dir, "tools/comb.config.json", body);

  const loaded = await loadConfig({ configFlag: "tools/comb.config.json", cwd: dir });

  assert.equal(loaded.configPath, path);
  assert.deepEqual(loaded.rules, ["no-console", "no-debugger", "semi"]);
  assert.deepEqual(loaded.replace, { from: "old", to: "new" });
  assert.deepEqual(loaded.report, { format: "csv", out: "out.csv" });
  // settings.target is relative to the config file's own directory (`tools/`).
  assert.equal(loaded.targetRoot, resolve(dir, "tools", "..", "src"));
  const expectedHash = createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.equal(loaded.configHash, expectedHash);
});

test("rules are deduplicated across config objects in first-seen order", async () => {
  const dir = tempDir();
  write(
    dir,
    "pocket-comb.config.mjs",
    `export default [
      { rules: { "a/one": "error", "b/two": 1 } },
      { rules: { "b/two": 2, "c/three": ["warn"] } },
    ];\n`,
  );
  const loaded = await loadConfig({ cwd: dir });
  assert.deepEqual(loaded.rules, ["a/one", "b/two", "c/three"]);
});

test("target precedence: flag beats settings, settings beats cwd", async () => {
  const dir = tempDir();
  write(
    dir,
    "tools/comb.config.mjs",
    `export default [{ rules: {}, settings: { "pocket-comb": { target: "../src" } } }];\n`,
  );

  const fromSettings = await loadConfig({ configFlag: "tools/comb.config.mjs", cwd: dir });
  assert.equal(fromSettings.targetRoot, resolve(dir, "src"));

  const fromFlag = await loadConfig({
    configFlag: "tools/comb.config.mjs",
    targetFlag: "flagroot",
    cwd: dir,
  });
  assert.equal(fromFlag.targetRoot, resolve(dir, "flagroot"));

  write(dir, "bare.config.mjs", `export default [{ rules: {} }];\n`);
  const fromCwd = await loadConfig({ configFlag: "bare.config.mjs", cwd: dir });
  assert.equal(fromCwd.targetRoot, dir);
});

test("a relative settings.target is not resolved against cwd", async () => {
  const dir = tempDir();
  write(
    dir,
    "deep/nested/comb.config.mjs",
    `export default [{ rules: {}, settings: { "pocket-comb": { target: ".." } } }];\n`,
  );
  const loaded = await loadConfig({ configFlag: "deep/nested/comb.config.mjs", cwd: dir });
  assert.equal(loaded.targetRoot, resolve(dir, "deep"));
});

test("replace and report flags take precedence over settings", async () => {
  const dir = tempDir();
  write(
    dir,
    "pocket-comb.config.mjs",
    `export default [{
      rules: {},
      settings: { "pocket-comb": {
        replace: { from: "old", to: "new" },
        report: { format: "csv", out: "settings.csv" },
      } },
    }];\n`,
  );

  const settingsOnly = await loadConfig({ cwd: dir });
  assert.deepEqual(settingsOnly.replace, { from: "old", to: "new" });
  assert.deepEqual(settingsOnly.report, { format: "csv", out: "settings.csv" });

  const overridden = await loadConfig({
    cwd: dir,
    replaceFlag: { from: "X", to: "Y" },
    reportFlag: { format: "html", out: "flag.html" },
  });
  assert.deepEqual(overridden.replace, { from: "X", to: "Y" });
  assert.deepEqual(overridden.report, { format: "html", out: "flag.html" });
});

test("replace / report are absent when neither flags nor settings carry them", async () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.mjs", `export default [{ rules: { "no-console": "warn" } }];\n`);
  const loaded: LoadedConfig = await loadConfig({ cwd: dir });
  assert.equal(loaded.replace, undefined);
  assert.equal(loaded.report, undefined);
});

test("autoDetectConfig finds the convention files in every supported extension", () => {
  for (const ext of ["mjs", "cjs", "json"] as const) {
    const dir = tempDir();
    const path = write(dir, `pocket-comb.config.${ext}`, ext === "json" ? "[]" : "module.exports = [];");
    assert.equal(autoDetectConfig(dir), path);
  }
});

test("autoDetectConfig prefers js over the other extensions", () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.json", "[]");
  write(dir, "pocket-comb.config.mjs", "export default [];");
  const js = write(dir, "pocket-comb.config.js", "module.exports = [];");
  assert.equal(autoDetectConfig(dir), js);
});

test("autoDetectConfig returns undefined when nothing is found", () => {
  assert.equal(autoDetectConfig(tempDir()), undefined);
});

test("a missing config is a precise operational error naming --config", async () => {
  const dir = tempDir();
  const err = await expectConfigError(loadConfig({ cwd: dir }));
  assert.match(err.message, /--config/);
  assert.equal(err.exitCode, 2);
});

test("a --config that does not exist is a precise operational error", async () => {
  const dir = tempDir();
  const err = await expectConfigError(loadConfig({ configFlag: "nope.config.mjs", cwd: dir }));
  assert.match(err.message, /nope\.config\.mjs/);
});

test("an unloadable config is a precise operational error", async () => {
  const dir = tempDir();
  write(dir, "comb.config.mjs", "export default [ { rules: { ]; this is not javascript\n");
  const err = await expectConfigError(loadConfig({ configFlag: "comb.config.mjs", cwd: dir }));
  assert.match(err.message, /comb\.config\.mjs/);
});

test("a config whose settings block is malformed is a precise operational error", async () => {
  const dir = tempDir();
  write(
    dir,
    "pocket-comb.config.mjs",
    `export default [{ rules: {}, settings: { "pocket-comb": { target: 42 } } }];\n`,
  );
  const err = await expectConfigError(loadConfig({ cwd: dir }));
  assert.match(err.message, /target/);
});

test("isActionableRule: >0 is actionable, 1 and 2 alike, off excluded", () => {
  for (const on of [1, 2, "warn", "error", [1], [2], ["warn", "x"], ["error", "x"]] as const) {
    assert.equal(isActionableRule(on), true, `${JSON.stringify(on)} should be actionable`);
  }
  for (const off of [0, "off", [0], ["off"], null, undefined, "bogus"] as const) {
    assert.equal(isActionableRule(off), false, `${JSON.stringify(off)} should be excluded`);
  }
});
