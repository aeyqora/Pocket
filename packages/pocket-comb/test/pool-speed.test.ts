import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { DEFAULT_BATCH_SIZE, defaultWorkerCount, runPool } from "../src/pool.js";
import type { RunPoolOptions } from "../src/pool.js";
import { cleanupTemps, tempDir, write } from "./harness.js";

after(cleanupTemps);

const CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-debugger": "warn", "no-unused-vars": "error" } },
];
`;

/** Big enough that lint dominates the ~60-90 ms per-worker boot (spike RESULTS). */
const FILE_COUNT = 2500;

/**
 * Each file carries enough violations that lint dominates the pool's fixed
 * overheads (boot, IPC, static-split stragglers). Tiny 1-violation files are
 * too cheap to show the payoff — the spike made the same observation at 1000
 * files — so this mirrors its "lint is the whole game" corpus shape.
 */
const FILE_BODY = "debugger;\nvar unused = 1;\n".repeat(40);

test(
  "pooled lint is measurably faster than serial on a multi-thousand-file corpus",
  { timeout: 180_000 },
  async (t) => {
    const cores = availableParallelism();
    if (cores < 2) {
      t.skip(`the pool needs more than one core (found ${cores})`);
      return;
    }

    const dir = tempDir("pocket-comb-perf-");
    const target = join(dir, "target");
    mkdirSync(target, { recursive: true });
    const files: string[] = [];
    for (let i = 0; i < FILE_COUNT; i++) {
      const file = join(target, `f${i}.js`);
      writeFileSync(file, FILE_BODY);
      files.push(file);
    }
    const configPath = write(dir, "comb.config.mjs", CONFIG);

    const request = (overrides: Partial<RunPoolOptions>): RunPoolOptions => ({
      files,
      configPath,
      cwd: target,
      action: "suppress",
      params: {},
      mode: "dry-run",
      workers: defaultWorkerCount(cores),
      batchSize: DEFAULT_BATCH_SIZE,
      serial: false,
      ...overrides,
    });

    const time = async (
      options: RunPoolOptions,
    ): Promise<{ ms: number; count: number; constructed: number }> => {
      const start = process.hrtime.bigint();
      const result = await runPool(options);
      return {
        ms: Number(process.hrtime.bigint() - start) / 1e6,
        count: result.files.length,
        constructed: result.workerStats.filter((stat) => stat.constructed === 1).length,
      };
    };

    // Warm the module graph and the pool wiring on a small slice so neither
    // path's first-run compile costs are charged to it.
    const warmup = files.slice(0, 64);
    await runPool(request({ files: warmup, serial: true }));
    await runPool(request({ files: warmup, workers: defaultWorkerCount(cores) }));

    const serial = await time(request({ serial: true }));
    const pooled = await time(request({ workers: defaultWorkerCount(cores) }));

    t.diagnostic(
      `${FILE_COUNT} files, ${cores} cores, pool ${defaultWorkerCount(cores)}: ` +
        `serial ${serial.ms.toFixed(0)} ms vs pooled ${pooled.ms.toFixed(0)} ms ` +
        `(${(serial.ms / pooled.ms).toFixed(2)}x)`,
    );

    assert.equal(serial.count, FILE_COUNT, "serial linted every file");
    assert.equal(pooled.count, FILE_COUNT, "the pool linted every file");
    assert.ok(pooled.constructed > 1, "the pooled run really used multiple worker threads");
    assert.ok(
      pooled.ms < serial.ms,
      `pooled (${pooled.ms.toFixed(0)} ms) should beat serial (${serial.ms.toFixed(0)} ms)`,
    );
  },
);
