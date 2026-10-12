import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BATCH_SIZE,
  PoolRecoveryError,
  defaultWorkerCount,
  runPool,
} from "../src/pool.js";
import { OperationalError } from "../src/errors.js";
import { cleanupTemps, tempDir, write } from "./harness.js";
import type { Worker } from "node:worker_threads";

after(cleanupTemps);

const CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-debugger": "warn", "no-unused-vars": "error" } },
];
`;

interface Fixture {
  dir: string;
  target: string;
  configPath: string;
  files: string[];
}

/** A target with `count` one-line dirty files plus an action config. */
function fixture(count: number): Fixture {
  const dir = tempDir();
  const target = join(dir, "target");
  const configPath = write(dir, "comb.config.mjs", CONFIG);
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    files.push(write(dir, `target/f${i}.js`, "debugger;\n"));
  }
  return { dir, target, configPath, files };
}

function request(fix: Fixture, overrides: Partial<Parameters<typeof runPool>[0]> = {}) {
  return {
    files: fix.files,
    configPath: fix.configPath,
    cwd: fix.target,
    action: "suppress" as const,
    params: {},
    mode: "dry-run" as const,
    workers: 2,
    batchSize: DEFAULT_BATCH_SIZE,
    serial: false,
    ...overrides,
  };
}

test("default pool size is ceil(cores x 0.75), min 1", () => {
  assert.equal(defaultWorkerCount(11), 9);
  assert.equal(defaultWorkerCount(8), 6);
  assert.equal(defaultWorkerCount(4), 3);
  assert.equal(defaultWorkerCount(3), 3);
  assert.equal(defaultWorkerCount(2), 2);
  assert.equal(defaultWorkerCount(1), 1);
  assert.equal(defaultWorkerCount(1), 1);
  assert.equal(defaultWorkerCount(0), 1, "never below one");
});

test("an unconfigured run uses the default pool size", async () => {
  const fix = fixture(10);

  const result = await runPool({
    files: fix.files,
    configPath: fix.configPath,
    cwd: fix.target,
    action: "suppress",
    params: {},
    mode: "dry-run",
  });

  assert.equal(result.serial, false);
  assert.equal(
    result.workerStats.length,
    defaultWorkerCount(availableParallelism()),
    "ceil(cores x 0.75) workers spawned",
  );
  assert.equal(result.batchSize ?? undefined, undefined);
  assert.equal(result.batchSize ?? undefined, undefined);
  assert.equal(result.files.length, 10);
});

test("apply mode flows through the pool without touching files (lint-only has no edits)", async () => {
  const fix = fixture(3);
  const stages: string[] = [];
  const before = fix.files.map((file) => readFileSync(file, "utf8"));

  const result = await runPool(
    request(fix, {
      workers: 2,
      batchSize: 2,
      mode: "apply",
      onProgress: (progress) => stages.push(progress.stage),
    }),
  );

  assert.ok(stages.includes("apply"), "apply is the reported stage");
  assert.ok(!stages.includes("lint"), "apply does not masquerade as a lint stage");
  assert.equal(result.files.length, 3);
  assert.deepEqual(
    fix.files.map((file) => readFileSync(file, "utf8")),
    before,
    "the lint-only strategy writes nothing",
  );
});

test("a pooled run lints every file with real, persistent worker threads", async () => {
  const fix = fixture(5);

  const result = await runPool(request(fix, { workers: 2, batchSize: 2 }));

  assert.equal(result.serial, false);
  assert.equal(result.workers, 2);
  assert.deepEqual(
    result.files.map((outcome) => outcome.filePath).sort(),
    [...fix.files].sort(),
    "every input file has an outcome",
  );
  assert.ok(
    result.files.every((outcome) => outcome.messages.length === 1),
    "each file carries its lint message",
  );

  assert.equal(result.workerStats.length, 2);
  // The workers really ran: each constructed one persistent instance and
  // completed at least one batch. A silent in-process fallback would fail here.
  assert.ok(
    result.workerStats.every((stat) => stat.constructed === 1),
    "one persistent instance per worker",
  );
  assert.ok(
    result.workerStats.every((stat) => stat.batches >= 1),
    "each worker completed work",
  );
  assert.equal(
    result.batches,
    result.workerStats.reduce((total, stat) => total + stat.batches, 0),
  );
});

test("workers persist across batches: one instance serves every batch", async () => {
  const fix = fixture(5);

  const result = await runPool(request(fix, { workers: 1, batchSize: 2 }));

  assert.equal(result.workerStats.length, 1);
  const stat = result.workerStats[0]!;
  // 5 files / batch 2 => 3 batches, all on the one instance.
  assert.equal(stat.batches, 3, "batch-size splits the chunk into three batches");
  assert.equal(stat.constructed, 1, "constructed once, never per batch");
  assert.notEqual(stat.instanceTag, "", "the ready handshake identified the instance");
  assert.equal(result.workers, 1);
});

test("--workers is honored: two workers split the chunk", async () => {
  const fix = fixture(6);

  const result = await runPool(request(fix, { workers: 2, batchSize: 2 }));

  assert.equal(result.workerStats.length, 2);
  assert.deepEqual(
    result.workerStats.map((stat) => stat.files),
    [3, 3],
    "a static equal split, 3 files each",
  );
  assert.equal(result.files.length, 6);
});

test("--serial runs a single in-process instance with no worker threads", async () => {
  const fix = fixture(5);

  const result = await runPool(request(fix, { serial: true }));

  assert.equal(result.serial, true);
  assert.equal(result.workers, 1);
  assert.deepEqual(result.workerStats, [], "serial spawns no workers");
  assert.deepEqual(
    result.files.map((outcome) => outcome.filePath).sort(),
    [...fix.files].sort(),
    "serial still lints every file",
  );
});

test("--batch-size is honored", async () => {
  const fix = fixture(10);

  const coarse = await runPool(request(fix, { workers: 1, batchSize: 16 }));
  const fine = await runPool(request(fix, { workers: 1, batchSize: 4 }));

  assert.equal(coarse.batches, 1, "batch 16 keeps 10 files in one task");
  assert.equal(fine.batches, 3, "batch 4 splits 10 files into three tasks");
  assert.equal(DEFAULT_BATCH_SIZE, 16);
});

test("progress reports the boot stage then lint counts summing to the total", async () => {
  const fix = fixture(5);
  const seen: Array<{ stage: string; done: number; total: number }> = [];

  const result = await runPool(
    request(fix, { workers: 2, batchSize: 2, onProgress: (progress) => seen.push(progress) }),
  );

  assert.equal(seen[0]?.stage, "boot");
  assert.equal(seen[0]?.total, 5);
  const last = seen.at(-1)!;
  assert.equal(last.stage, "lint");
  assert.equal(last.done, result.files.length);
  assert.equal(last.total, 5);
  // Counts only ever climb.
  const lintDone = seen.filter((entry) => entry.stage === "lint").map((entry) => entry.done);
  assert.deepEqual(lintDone, [...lintDone].sort((a, b) => a - b));
});

test("a killed worker's chunk re-runs once in-process and the run completes", async () => {
  const fix = fixture(4);

  const result = await runPool(
    request(fix, {
      workers: 1,
      batchSize: 1,
      onWorkerSpawn: (worker: Worker) => {
        void worker.terminate();
      },
    }),
  );

  const stat = result.workerStats[0]!;
  assert.equal(stat.crashed, true, "the kill was observed");
  assert.equal(stat.recovered, 1, "the chunk was retried exactly once");
  assert.equal(result.recoveredFiles, 4, "the whole chunk re-ran on the main thread");
  assert.deepEqual(
    result.files.map((outcome) => outcome.filePath).sort(),
    [...fix.files].sort(),
    "every file still has exactly one outcome",
  );
});

test("a second failure exits 2 with the partial state reported", async () => {
  const fix = fixture(2);
  const missing = join(fix.target, "does-not-exist.js");

  await assert.rejects(
    runPool(request(fix, { files: [...fix.files, missing], workers: 1, batchSize: 1 })),
    (error: unknown) => {
      assert.ok(error instanceof PoolRecoveryError, "a typed operational error");
      assert.ok(error instanceof OperationalError);
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /partial state/);
      assert.equal(error.partial.files.length, 2, "the two good files are reported");
      assert.deepEqual(
        error.partial.files.map((outcome) => outcome.filePath).sort(),
        [...fix.files].sort(),
      );
      return true;
    },
  );
});
