import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createIsolatedESLint, type DroppedFile, type FatalFile } from "./eslint.js";
import { runBatch, type RunBatchResult } from "./engine.js";
import { OperationalError } from "./errors.js";
import type { Action, BatchOutcome, JsonValue, RunMode } from "./types.js";
import type { WorkerInit, WorkerToParent } from "./worker.js";
import type { ESLint } from "eslint";

export type { BatchOutcome } from "./types.js";

/** Files per task; measured best (spike RESULTS, spec §8). */
export const DEFAULT_BATCH_SIZE = 16;

/** The pool fraction from spec §8: `ceil(cores × 0.75)`, min 1. */
export const WORKER_CORE_FRACTION = 0.75;

/** Default pool size: `ceil(cores × 0.75)`, min 1. */
export function defaultWorkerCount(cores: number = availableParallelism()): number {
  return Math.max(1, Math.ceil(cores * WORKER_CORE_FRACTION));
}

export interface Progress {
  stage: string;
  done: number;
  total: number;
}

export interface RunPoolOptions {
  /** Absolute file list (discovery's output). */
  files: string[];
  configPath: string;
  cwd: string;
  action: Action;
  params: JsonValue;
  mode: RunMode;
  /** Pool size; defaults to `defaultWorkerCount()`. */
  workers?: number;
  /** Files per task; defaults to `DEFAULT_BATCH_SIZE` (16). */
  batchSize?: number;
  /** No pool: one in-process instance, on the main thread. Defaults to false. */
  serial?: boolean;
  /**
   * Ticket 08, `suppress --fix-first`: each worker (or the serial run) builds a
   * second, fix-enabled instance and the batch fixes before it suppresses.
   */
  fixFirst?: boolean;
  onProgress?: (progress: Progress) => void;
  /**
   * Diagnostic/test seam: observed once per spawned worker thread. Production
   * callers leave it unset; a test uses it to exercise the resilience path.
   */
  onWorkerSpawn?: (worker: Worker, workerId: number) => void;
}

export interface WorkerStat {
  workerId: number;
  /** The persistent instance's tag from `ready` ("" if it never warmed). */
  instanceTag: string;
  /** Batches this worker completed itself. */
  batches: number;
  /** Files this worker completed itself. */
  files: number;
  /** ESLint instances the worker constructed: 1 once warmed, else 0. */
  constructed: number;
  crashed: boolean;
  /** In-process recovery attempts made for this worker's chunk. */
  recovered: number;
}

export interface RunPoolResult {
  /** Per-file outcomes, in the pool's completion order. */
  files: BatchOutcome[];
  workers: number;
  serial: boolean;
  batches: number;
  dropped: DroppedFile[];
  fatal: FatalFile[];
  /**
   * Per-worker facts. Additive to the architecture-notes contract (which pinned
   * only `{ files, workers }`): tests read persistence/resilience here, and the
   * report tolerates its absence.
   */
  workerStats: WorkerStat[];
  /** Files the main thread re-ran in-process because their worker failed. */
  recoveredFiles: number;
}

/**
 * A worker's chunk failed and its one in-process retry failed too: the run is an
 * operational error (exit 2), carrying the partial state so far.
 */
export class PoolRecoveryError extends OperationalError {
  readonly partial: RunPoolResult;

  constructor(message: string, partial: RunPoolResult) {
    super(message);
    this.partial = partial;
  }
}

interface BatchPlan {
  workerId: number;
  batchId: number;
  files: string[];
}

/** `RunPoolOptions` with the optional knobs resolved to their defaults. */
interface NormalizedPoolOptions extends RunPoolOptions {
  workers: number;
  batchSize: number;
  serial: boolean;
}

/**
 * Run the action across the file list: the persistent worker pool by default, or
 * a single in-process instance when `serial` is set. Pool size defaults to
 * `ceil(cores × 0.75)` (min 1); batch size to 16.
 */
export async function runPool(options: RunPoolOptions): Promise<RunPoolResult> {
  const normalized: NormalizedPoolOptions = {
    ...options,
    workers: Math.max(1, Math.floor(options.workers ?? defaultWorkerCount())),
    batchSize: Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE)),
    serial: options.serial ?? false,
  };
  return normalized.serial ? runSerial(normalized) : runParallel(normalized);
}

async function runSerial(options: NormalizedPoolOptions): Promise<RunPoolResult> {
  const { files, batchSize, configPath, cwd, action, params, mode, fixFirst } = options;
  const stage = mode === "apply" ? "apply" : "lint";
  options.onProgress?.({ stage: "boot", done: 0, total: files.length });

  const eslint = createIsolatedESLint({
    configPath,
    cwd,
    ...(action === "fix" ? { fix: true } : {}),
  });
  const fixEslint =
    fixFirst === true ? createIsolatedESLint({ configPath, cwd, fix: true }) : undefined;
  const outcomes: BatchOutcome[] = [];
  const dropped: DroppedFile[] = [];
  const fatal: FatalFile[] = [];
  let batches = 0;
  let done = 0;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const result = await runBatch(eslint, batch, {
      action,
      params,
      mode,
      ...(fixFirst === true ? { fixFirst: true } : {}),
      ...(fixEslint === undefined ? {} : { fixEslint }),
    });
    outcomes.push(...result.outcomes);
    dropped.push(...result.dropped);
    fatal.push(...result.fatal);
    batches += 1;
    done += batch.length;
    options.onProgress?.({ stage, done, total: files.length });
  }

  return {
    files: outcomes,
    workers: 1,
    serial: true,
    batches,
    dropped,
    fatal,
    workerStats: [],
    recoveredFiles: 0,
  };
}

async function runParallel(options: NormalizedPoolOptions): Promise<RunPoolResult> {
  const { files, configPath, cwd, action, params, mode, fixFirst } = options;
  const total = files.length;
  const workers = options.workers;
  const batchSize = options.batchSize;
  const stage = mode === "apply" ? "apply" : "lint";

  // Static equal split (spec §8), planned up front so a worker that dies before
  // it is ready still has a chunk to recover.
  const sliceSize = Math.ceil(total / workers);
  const plans: BatchPlan[] = [];
  let nextBatchId = 0;
  for (let w = 0; w < workers; w++) {
    const slice = files.slice(w * sliceSize, (w + 1) * sliceSize);
    for (let j = 0; j < slice.length; j += batchSize) {
      plans.push({ workerId: w, batchId: nextBatchId++, files: slice.slice(j, j + batchSize) });
    }
  }
  const planById = new Map(plans.map((plan) => [plan.batchId, plan]));
  const warmupFor = new Map<number, string>();
  for (const plan of plans) {
    const first = plan.files[0];
    if (first !== undefined && !warmupFor.has(plan.workerId)) warmupFor.set(plan.workerId, first);
  }

  options.onProgress?.({ stage: "boot", done: 0, total });

  return await new Promise<RunPoolResult>((resolve, reject) => {
    const outcomes: BatchOutcome[] = [];
    const dropped: DroppedFile[] = [];
    const fatal: FatalFile[] = [];
    const workerStats: WorkerStat[] = Array.from({ length: workers }, (_, workerId) => ({
      workerId,
      instanceTag: "",
      batches: 0,
      files: 0,
      constructed: 0,
      crashed: false,
      recovered: 0,
    }));
    const threads: Array<Worker | null> = new Array<Worker | null>(workers).fill(null);
    const pending: Array<Set<number>> = Array.from({ length: workers }, () => new Set<number>());
    for (const plan of plans) pending[plan.workerId]!.add(plan.batchId);

    let batches = 0;
    let done = 0;
    let recoveredFiles = 0;
    let outstanding = plans.length;
    let recoveryEslint: ESLint | null = null;
    let recoveryFixEslint: ESLint | null = null;
    let settled = false;
    let failure: unknown = null;

    const partial = (): RunPoolResult => ({
      files: outcomes,
      workers,
      serial: false,
      batches,
      dropped,
      fatal,
      workerStats,
      recoveredFiles,
    });

    const terminateAll = (): void => {
      for (const thread of threads) thread?.terminate();
    };

    const finish = (): void => {
      if (settled) return;
      if (failure !== null) {
        settled = true;
        terminateAll();
        reject(
          new PoolRecoveryError(
            `worker failure could not be recovered in-process: ${describe(failure)}; ` +
              `partial state: ${done}/${total} files linted`,
            partial(),
          ),
        );
        return;
      }
      if (outstanding === 0) {
        settled = true;
        terminateAll();
        resolve(partial());
      }
    };

    const record = (plan: BatchPlan, result: RunBatchResult, byWorker: boolean): void => {
      outcomes.push(...result.outcomes);
      dropped.push(...result.dropped);
      fatal.push(...result.fatal);
      batches += 1;
      done += plan.files.length;
      outstanding -= 1;
      if (byWorker) {
        const stat = workerStats[plan.workerId]!;
        stat.batches += 1;
        stat.files += plan.files.length;
      }
      options.onProgress?.({ stage, done, total });
      finish();
    };

    // A crashed/failed worker's un-completed batch ids re-run once, in-process.
    const recover = async (workerId: number): Promise<void> => {
      workerStats[workerId]!.recovered += 1;
      const ids = [...pending[workerId]!].sort((a, b) => a - b);
      for (const id of ids) {
        if (settled) return;
        const plan = planById.get(id)!;
        const eslint = (recoveryEslint ??= createIsolatedESLint({
          configPath,
          cwd,
          ...(action === "fix" ? { fix: true } : {}),
        }));
        const fixEslint =
          fixFirst === true
            ? (recoveryFixEslint ??= createIsolatedESLint({ configPath, cwd, fix: true }))
            : undefined;
        const result = await runBatch(eslint, plan.files, {
          action,
          params,
          mode,
          ...(fixFirst === true ? { fixFirst: true } : {}),
          ...(fixEslint === undefined ? {} : { fixEslint }),
        });
        pending[workerId]!.delete(id);
        recoveredFiles += plan.files.length;
        record(plan, result, false);
      }
    };

    const handleFailure = (workerId: number): void => {
      if (settled) return;
      const stat = workerStats[workerId]!;
      if (stat.crashed) return;
      stat.crashed = true;
      threads[workerId]?.terminate();
      void recover(workerId).then(finish, (err: unknown) => {
        failure = err;
        finish();
      });
    };

    const handleMessage = (workerId: number, message: WorkerToParent): void => {
      if (settled) return;
      if (message.type === "ready") {
        const stat = workerStats[workerId]!;
        stat.instanceTag = message.instanceTag;
        stat.constructed = message.constructed;
        dispatch(workerId);
        return;
      }
      if (message.type === "batch-done") {
        // A late message for an already-recovered batch is stale.
        if (!pending[workerId]!.has(message.batchId)) return;
        pending[workerId]!.delete(message.batchId);
        record(
          planById.get(message.batchId)!,
          { outcomes: message.outcomes, dropped: message.dropped, fatal: message.fatal },
          true,
        );
        return;
      }
      if (message.type === "batch-failed") handleFailure(workerId);
    };

    const dispatched = new Set<number>();
    const dispatch = (workerId: number): void => {
      if (dispatched.has(workerId)) return;
      dispatched.add(workerId);
      const thread = threads[workerId];
      if (thread === null || thread === undefined) return;
      for (const plan of plans) {
        if (plan.workerId !== workerId) continue;
        thread.postMessage({ type: "lint", batchId: plan.batchId, files: plan.files });
      }
    };

    if (plans.length === 0) {
      finish();
      return;
    }

    const entry = resolveWorkerEntry(import.meta.url);
    for (let w = 0; w < workers; w++) {
      const warmup = warmupFor.get(w);
      const init: WorkerInit = {
        workerId: w,
        configPath,
        cwd,
        action,
        params,
        mode,
        ...(fixFirst === true ? { fixFirst: true } : {}),
        ...(warmup === undefined ? {} : { warmupFile: warmup }),
      };
      let thread: Worker;
      try {
        thread = new Worker(entry.url, { workerData: init, execArgv: entry.execArgv });
      } catch {
        // Even construction failure gets the same one-shot in-process recovery;
        // only a failed recovery becomes the run's operational error.
        workerStats[w]!.crashed = true;
        void recover(w).then(finish, (err2: unknown) => {
          failure = err2;
          finish();
        });
        continue;
      }
      threads[w] = thread;
      thread.on("message", (message: WorkerToParent) => handleMessage(w, message));
      thread.on("error", () => handleFailure(w));
      thread.on("messageerror", () => handleFailure(w));
      thread.on("exit", () => {
        if (settled) return;
        if (pending[w]!.size > 0 || workerStats[w]!.constructed === 0) handleFailure(w);
        else finish();
      });
      // Listeners are attached first so a test hook that terminates the worker
      // on sight cannot race the handlers.
      options.onWorkerSpawn?.(thread, w);
    }

    if (failure !== null) finish();
  });
}

interface WorkerEntry {
  url: URL;
  execArgv: string[];
}

/**
 * Resolve the worker entry for both worlds a test or a user can be in:
 *
 * - the built CLI runs `dist/pool.js`, so `./worker.js` exists and needs no loader;
 * - `node --import tsx` runs `src/pool.ts`, where `./worker.js` does not exist and
 *   the entry is `./worker.ts`, spawned with the same tsx loader.
 *
 * `new URL("./worker.js", import.meta.url)` alone resolves to a file that only
 * exists in one of the two, which is the pitfall this guards.
 */
function resolveWorkerEntry(metaUrl: string): WorkerEntry {
  const compiled = new URL("./worker.js", metaUrl);
  if (existsSync(fileURLToPath(compiled))) return { url: compiled, execArgv: [] };
  const source = new URL("./worker.ts", metaUrl);
  if (existsSync(fileURLToPath(source))) return { url: source, execArgv: ["--import", "tsx"] };
  // Neither candidate exists: let Node surface the missing-file error verbatim.
  return { url: compiled, execArgv: [] };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
