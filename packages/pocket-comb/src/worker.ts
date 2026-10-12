import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { createIsolatedESLint, lintFiles, type DroppedFile, type FatalFile } from "./eslint.js";
import { runBatch } from "./engine.js";
import type { Action, BatchOutcome, JsonValue, RunMode } from "./types.js";
import type { ESLint } from "eslint";

/**
 * Boot data for one worker. Everything ESLint needs is cloneable strings, so the
 * instance is built from `workerData` with no per-batch construction (spec §8).
 */
export interface WorkerInit {
  workerId: number;
  configPath: string;
  cwd: string;
  action: Action;
  params: JsonValue;
  mode: RunMode;
  /**
   * Ticket 08: `suppress --fix-first` — the worker builds a second, fix-enabled
   * instance for the fix phase. The `fix` action instead fix-enables its one
   * instance (`action === "fix"`).
   */
  fixFirst?: boolean;
  /**
   * The first file this worker owns. Linted once at boot so the true warm cost
   * (config load + rule compilation) is paid before the pool dispatches work.
   */
  warmupFile?: string;
}

/** Parent -> worker: lint one batch. */
export interface LintBatchMessage {
  type: "lint";
  batchId: number;
  files: string[];
}

export type ParentToWorker = LintBatchMessage;

/** Worker -> parent: the persistent instance is constructed and warmed. */
export interface ReadyMessage {
  type: "ready";
  workerId: number;
  /** Stable tag of the one ESLint instance this worker reuses for every batch. */
  instanceTag: string;
  /** How many ESLint instances this worker has constructed: always 1 here. */
  constructed: number;
  constructMs: number;
  warmMs: number;
}

/** Worker -> parent: one batch's per-file outcomes. */
export interface BatchDoneMessage {
  type: "batch-done";
  workerId: number;
  instanceTag: string;
  batchId: number;
  outcomes: BatchOutcome[];
  dropped: DroppedFile[];
  fatal: FatalFile[];
  ms: number;
  firstBatch: boolean;
}

/**
 * Worker -> parent: a batch threw (e.g. a missing explicit path). Reported rather
 * than crashing the thread so the pool can run its one in-process recovery.
 */
export interface BatchFailedMessage {
  type: "batch-failed";
  workerId: number;
  batchId: number;
  error: string;
}

export type WorkerToParent = ReadyMessage | BatchDoneMessage | BatchFailedMessage;

const hr = (): number => Number(process.hrtime.bigint() / 1000n);

async function main(init: WorkerInit, port: NonNullable<typeof parentPort>): Promise<void> {
  const instanceTag = randomUUID();

  // ONE persistent ESLint instance, constructed at boot and reused for every
  // batch. Construct is lazy (~0.4 ms); the first lintFiles is the real warm.
  // The count is real, so a regression that rebuilt per batch would report > 1.
  // The `fix` action fix-enables its one instance; `suppress --fix-first`
  // builds a second, fix-enabled instance for the fix phase.
  let constructed = 0;
  const buildInstance = (fix: boolean): ESLint => {
    constructed += 1;
    return createIsolatedESLint({
      configPath: init.configPath,
      cwd: init.cwd,
      ...(fix ? { fix: true } : {}),
    });
  };
  const constructStart = hr();
  const eslint = buildInstance(init.action === "fix");
  const fixEslint = init.fixFirst === true ? buildInstance(true) : undefined;
  const constructMs = hr() - constructStart;

  let warmMs = 0;
  if (init.warmupFile !== undefined) {
    const warmStart = hr();
    // Warm with a plain lint, never the action: warming must not write.
    await lintFiles(eslint, [init.warmupFile]);
    warmMs = hr() - warmStart;
  }

  port.postMessage({
    type: "ready",
    workerId: init.workerId,
    instanceTag,
    constructed,
    constructMs,
    warmMs,
  } satisfies ReadyMessage);

  // Batches are drained one at a time against the single instance; the queue
  // absorbs everything the pool posts while a batch is in flight.
  const queue: LintBatchMessage[] = [];
  let busy = false;
  let firstBatch = true;

  const drain = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    while (queue.length > 0) {
      const message = queue.shift()!;
      const started = hr();
      try {
        const result = await runBatch(eslint, message.files, {
          action: init.action,
          params: init.params,
          mode: init.mode,
          ...(init.fixFirst === true ? { fixFirst: true } : {}),
          ...(fixEslint === undefined ? {} : { fixEslint }),
        });
        port.postMessage({
          type: "batch-done",
          workerId: init.workerId,
          instanceTag,
          batchId: message.batchId,
          outcomes: result.outcomes,
          dropped: result.dropped,
          fatal: result.fatal,
          ms: hr() - started,
          firstBatch,
        } satisfies BatchDoneMessage);
      } catch (err) {
        port.postMessage({
          type: "batch-failed",
          workerId: init.workerId,
          batchId: message.batchId,
          error: err instanceof Error ? err.message : String(err),
        } satisfies BatchFailedMessage);
      }
      firstBatch = false;
    }
    busy = false;
  };

  port.on("message", (message: ParentToWorker) => {
    if (message.type !== "lint") return;
    queue.push(message);
    void drain();
  });
}

// The module is only ever spawned as an entry, but guard anyway so a stray
// import never tries to talk to a parent port that is not there.
if (parentPort !== null) {
  await main(workerData as WorkerInit, parentPort);
}
