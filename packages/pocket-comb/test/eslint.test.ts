import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createIsolatedESLint, lintFiles } from "../src/eslint.js";
import { discover, DEFAULT_EXTENSIONS } from "../src/discovery.js";
import { cleanupTemps, tempDir, write } from "./harness.js";

after(cleanupTemps);

const ACTION_CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-debugger": "warn", "no-unused-vars": "error" } },
];
`;

test("the repo's own eslint.config.js is never read: the action config drives everything", async () => {
  const dir = tempDir();
  // If this repo config were read, no-debugger would be off and no-console on.
  write(
    dir,
    "repo/eslint.config.js",
    `export default [{ rules: { "no-debugger": "off", "no-console": "error" } }];\n`,
  );
  const target = join(dir, "target");
  write(dir, "target/app.js", "debugger;\nvar unused = 1;\nconsole.log(1);\n");
  const configPath = write(dir, "comb.config.mjs", ACTION_CONFIG);

  const eslint = createIsolatedESLint({ configPath, cwd: target });

  // Self-check from spec §10: the isolated instance reports the action config.
  assert.equal(await eslint.findConfigFile(), configPath);

  const { results } = await lintFiles(eslint, [join(target, "app.js")]);
  const result = results.find((entry) => entry.filePath === join(target, "app.js"));
  assert.ok(result, "app.js was linted");

  const byRule = new Map(result.messages.map((m) => [m.ruleId, m]));
  // warn and error severities are both actionable.
  assert.equal(byRule.get("no-debugger")?.severity, 1);
  assert.equal(byRule.get("no-unused-vars")?.severity, 2);
  // The repo config's rule never fires.
  assert.equal(byRule.has("no-console"), false);
});

test("relative files/ignores globs resolve against the target root, not the config dir", async () => {
  const dir = tempDir();
  // The config lives in `tools/`, which has no `src/` or `skip/` of its own: if
  // the globs resolved against the config file's directory, `src/a.js` would be
  // unconfigured and `skip/b.js` would lint instead of dropping.
  const configPath = write(
    dir,
    "tools/comb.config.mjs",
    `export default [
      { ignores: ["skip/**"] },
      { files: ["src/**/*.js"], rules: { "no-debugger": "warn" } },
    ];\n`,
  );
  const target = join(dir, "target");
  write(dir, "target/src/a.js", "debugger;\n");
  write(dir, "target/skip/b.js", "debugger;\n");
  write(dir, "target/top.ts", "export type T = 1;\n");
  const eslint = createIsolatedESLint({ configPath, cwd: target });

  const { results, dropped } = await lintFiles(eslint, [
    join(target, "src/a.js"),
    join(target, "skip/b.js"),
    join(target, "top.ts"),
  ]);

  const linted = results.find((entry) => entry.filePath === join(target, "src/a.js"));
  assert.ok(linted, "src/a.js was linted");
  // The rules only arrive if the `src/**/*.js` files-glob matched against the
  // target root: with a wrong cwd, the built-in JS default would lint a.js with
  // no rules and this message would be missing.
  assert.equal(linted.messages[0]?.ruleId, "no-debugger");
  assert.deepEqual(dropped, [
    { filePath: join(target, "skip/b.js"), kind: "ignored" },
    { filePath: join(target, "top.ts"), kind: "unconfigured" },
  ]);
});

test("a file outside the target root is classified as an external drop", async () => {
  const dir = tempDir();
  const target = join(dir, "target");
  write(dir, "target/app.js", "debugger;\n");
  const external = write(dir, "outside/other.js", "debugger;\n");
  const configPath = write(dir, "comb.config.mjs", ACTION_CONFIG);
  const eslint = createIsolatedESLint({ configPath, cwd: target });

  const { results, dropped } = await lintFiles(eslint, [external]);

  assert.deepEqual(results, []);
  assert.deepEqual(dropped, [{ filePath: external, kind: "external" }]);
});

test("synthetic ignored-file warnings never surface as violations", async () => {
  const dir = tempDir();
  const target = join(dir, "target");
  const ignored = write(dir, "target/skip/inside.js", "debugger;\n");
  const configPath = write(
    dir,
    "comb.config.mjs",
    `export default [
      { ignores: ["skip/**"] },
      { files: ["**/*.js"], rules: { "no-debugger": "warn" } },
    ];\n`,
  );
  const eslint = createIsolatedESLint({ configPath, cwd: target });

  const { results, dropped } = await lintFiles(eslint, [ignored]);

  assert.deepEqual(results, [], "a purely-ignored file yields no lint result");
  assert.deepEqual(dropped, [{ filePath: ignored, kind: "ignored" }]);
  for (const result of results) {
    for (const message of result.messages) {
      assert.equal(
        message.message.startsWith("File ignored"),
        false,
        "no synthetic ignored-file warning leaks into the results",
      );
    }
  }
});

test("a file with a syntax error is reported and skipped, and the run completes", async () => {
  const dir = tempDir();
  const target = join(dir, "target");
  const good = write(dir, "target/good.js", "debugger;\n");
  const broken = write(dir, "target/broken.js", "const = ;\n");
  const configPath = write(dir, "comb.config.mjs", ACTION_CONFIG);
  const eslint = createIsolatedESLint({ configPath, cwd: target });

  const { results, fatal } = await lintFiles(eslint, [good, broken]);

  assert.deepEqual(
    results.map((entry) => entry.filePath),
    [good],
    "the good file still lints",
  );
  assert.equal(fatal.length, 1);
  assert.equal(fatal[0]?.filePath, broken);
  assert.match(fatal[0]?.message ?? "", /Parsing error/);
});

test("discovered / linted / dropped counts are produced for the run summary", async () => {
  const dir = tempDir();
  const target = join(dir, "target");
  write(dir, "target/src/a.js", "debugger;\n");
  write(dir, "target/src/clean.js", "export default 1;\n");
  write(dir, "target/skip/b.js", "debugger;\n");
  write(dir, "target/other.ts", "export type T = 1;\n");
  const configPath = write(
    dir,
    "comb.config.mjs",
    `export default [
      { ignores: ["skip/**"] },
      { files: ["**/*.js"], rules: { "no-debugger": "warn" } },
    ];\n`,
  );

  const discovered = await discover({ target, extensions: [...DEFAULT_EXTENSIONS] });
  const eslint = createIsolatedESLint({ configPath, cwd: target });
  const { results, dropped } = await lintFiles(eslint, discovered.files);

  assert.equal(discovered.count, 4);
  assert.equal(results.length, 2, "src/a.js and src/clean.js were linted");
  assert.equal(
    dropped.length,
    discovered.count - results.length,
    "every discovered file is accounted for",
  );
});
