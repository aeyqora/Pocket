import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, cleanupTemps, tempDir, write } from "./harness.js";

after(cleanupTemps);

/**
 * The tsx-run tests import `src/pool.js`, so the pool must resolve `src/worker.ts`
 * and spawn it with the tsx loader. The built CLI imports `dist/pool.js`, so the
 * pool must resolve `dist/worker.js` and spawn it with no loader. This runs the
 * built artifact in a subprocess to prove the second half of that pair.
 */
test("the built dist pool spawns the built dist worker (no tsx loader)", () => {
  const dir = tempDir("pocket-comb-dist-");
  const target = join(dir, "target");
  mkdirSync(target, { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < 4; i++) {
    const file = join(target, `f${i}.js`);
    writeFileSync(file, "debugger;\n");
    files.push(file);
  }
  const configPath = write(
    dir,
    "comb.config.mjs",
    `export default [{ files: ["**/*.js"], rules: { "no-debugger": "warn" } }];\n`,
  );

  const poolUrl = pathToFileURL(join(ROOT, "dist", "pool.js")).href;
  const script = join(dir, "run.mjs");
  writeFileSync(
    script,
    [
      `import { runPool } from ${JSON.stringify(poolUrl)};`,
      `const result = await runPool({`,
      `  files: ${JSON.stringify(files)},`,
      `  configPath: ${JSON.stringify(configPath)},`,
      `  cwd: ${JSON.stringify(target)},`,
      `  action: "suppress",`,
      `  params: {},`,
      `  mode: "dry-run",`,
      `  workers: 2,`,
      `  batchSize: 2,`,
      `});`,
      `process.stdout.write(JSON.stringify({`,
      `  files: result.files.length,`,
      `  constructed: result.workerStats.filter((stat) => stat.constructed === 1).length,`,
      `}));`,
    ].join("\n"),
  );

  const res = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);

  const output = JSON.parse(res.stdout) as { files: number; constructed: number };
  assert.equal(output.files, 4, "the built pool linted every file");
  assert.equal(output.constructed, 2, "two real built worker threads were used");
});
