/**
 * The separate perf timing suite (spec §11) — the deterioration tripwire.
 *
 * Methodology: warm up, then take measured runs per stage and compare the
 * **minimum across runs** against a committed baseline **keyed by platform**
 * (`os` + CPU model + Node version), failing when **any** stage exceeds the
 * baseline by more than 15% (`--threshold`). **Every** stage is gated; the median
 * is reported but the gate uses the minimum (see `gatedMs`), and a forced GC
 * precedes each sample. `--update-baseline` re-pins deliberately; it is never
 * part of a normal run.
 *
 * The stages cover the whole pipeline: `discover` / `lint` / `scan` / `plan` /
 * `apply` / `scan-full` / `report`, plus one `action:<verb>` stage per action
 * (each runs that action's strategy over the **already-linted** corpus — no
 * re-lint). The engine stages consume the lint stage's recorded messages and the
 * file text, so they measure engine time only.
 *
 * This module is wired to `npm run test:perf`; it must never run under
 * `npm test`, which is correctness-only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, platform as osPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { censusFileScan } from "../src/census.js";
import { DEFAULT_EXTENSIONS, discover } from "../src/discovery.js";
import {
  applySuppressEdits,
  planSuppressEdits,
  runActionForFile,
  scanSuppressFile,
  type PlannedEdit,
  type StrategyParams,
  type SuppressTarget,
} from "../src/engine.js";
import { scanDirectives } from "../src/scan.js";
import { buildRunReport, orderEdits, type RunMeta } from "../src/ledger.js";
import { DEFAULT_BATCH_SIZE, defaultWorkerCount, runPool } from "../src/pool.js";
import type { RunPoolResult } from "../src/pool.js";
import { renderReport } from "../src/report/index.js";
import { VERSION } from "../src/version.js";
import type { Action } from "../src/types.js";
import {
  DEFAULT_FILE_COUNT,
  DEFAULT_SEED,
  STRESS_FILE_COUNT,
  defaultCorpusDir,
  generateCorpus,
} from "./generate.js";

/** The committed action config the corpus is linted with. */
export const CORPUS_CONFIG_PATH = fileURLToPath(new URL("./corpus.config.mjs", import.meta.url));

/** The committed, platform-keyed baseline. */
export const BASELINE_PATH = fileURLToPath(new URL("./baseline.json", import.meta.url));

/** The only action the lint stage runs today (the engine's strategies land later). */
const LINT_ACTION: Action = "suppress";

/** Default regression factor: fail when the gated statistic exceeds baseline × 1.15. */
export const DEFAULT_THRESHOLD = 1.15;

/**
 * Measured runs after warmup (spec §11). **Every** measured stage is gated, and
 * the gate compares the **minimum** across runs (see `gatedMs`), so a higher run
 * count directly tightens the statistic: more samples means a better chance of
 * catching the stage's uncontended cost. Fifteen matches the pinning count so a
 * pinned baseline and a comparison run sample identically.
 */
export const DEFAULT_RUNS = 15;

/**
 * Warmup runs before measuring. The spec pins only "after warmup". Ten is chosen
 * empirically: the cheapest stage (`discover` on the 2,000-file default corpus)
 * walks in ~5 ms, and a cold filesystem cache makes the first several walks
 * 15–22 ms; seven warmups left a tail that could drag the statistic past the
 * 1.15 gate on an unlucky process, while ten settles it to a ±3% band across
 * fresh processes (see `perf/README.md`). The pool also rebuilds its workers
 * every measured run, so a longer warmup keeps that cost out of the measured
 * band.
 */
export const DEFAULT_WARMUP = 10;

// --- measurement shapes -------------------------------------------------------

export interface StageResult {
  stage: string;
  /** Every measured run, in order (ms). */
  runsMs: number[];
  medianMs: number;
  minMs: number;
  maxMs: number;
  /** Optional µs/file micro-timing for engine stages (ticket 05). */
  perFileUs?: number;
}

export interface ScaleMeasurement {
  scale: string;
  files: number;
  warmup: number;
  runs: number;
  stages: StageResult[];
}

export interface PlatformKey {
  os: string;
  cpuModel: string;
  node: string;
}

export interface PerfMeasurement {
  platform: PlatformKey;
  measuredAt: string;
  scales: ScaleMeasurement[];
}

// --- baseline shapes ----------------------------------------------------------

export interface BaselineScale {
  files: number;
  warmup: number;
  runs: number;
  /** stage name -> gated ms (the minimum across runs; see `gatedMs`). */
  stages: Record<string, number>;
}

export interface BaselineEntry {
  platform: PlatformKey;
  scales: Record<string, BaselineScale>;
}

export interface BaselineFile {
  schema: 1;
  /** platform id (`os|cpuModel|node`) -> entry. */
  baselines: Record<string, BaselineEntry>;
}

/**
 * The statistic the gate compares: the **minimum** across the measured runs, not
 * the median. The spec reports medians (and `StageResult.medianMs` is still
 * reported), but a median on a shared, non-idle machine inherits whatever
 * background load (Spotlight, browsers, other CI jobs) the process happened to
 * run under — at the 2,000-file default the post-lint stages are 0.3–10 ms, and
 * the median swung 20–30% process to process. The minimum is the least-contended
 * sample, so it estimates the stage's real cost and is stable enough to gate at
 * ×1.15; a genuine regression raises the minimum too (proven by the injected-
 * slowdown test). This is the anti-flake control the review follow-up sanctioned;
 * see `perf/README.md`.
 */
export function gatedMs(stage: StageResult): number {
  return stage.minMs;
}

export interface StageComparison {
  stage: string;
  /** The measured median (always reported). */
  medianMs: number;
  /** The statistic the gate compares: the minimum across runs. */
  gatedMs: number;
  baselineMs: number;
  ratio: number;
  ok: boolean;
}

export interface StageFailure {
  scale: string;
  stage: string;
  gatedMs: number;
  baselineMs: number;
  ratio: number;
}

export interface PerfVerdict {
  ok: boolean;
  /** True when this platform has no entry in the committed baseline. */
  missing: boolean;
  failures: StageFailure[];
}

// --- platform key -------------------------------------------------------------

/** The platform key spec §11 mandates: os + CPU model + Node version. */
export function platformKey(): PlatformKey {
  return {
    os: osPlatform(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    node: process.version,
  };
}

/** A stable single-string id for the baseline map. */
export function platformId(key: PlatformKey): string {
  return `${key.os}|${key.cpuModel}|${key.node}`;
}

// --- baseline I/O -------------------------------------------------------------

const EMPTY_BASELINE: BaselineFile = { schema: 1, baselines: {} };

/** Load the committed baseline; a missing file reads as empty (never a crash). */
export function loadBaseline(path: string): BaselineFile {
  if (!existsSync(path)) return { schema: 1, baselines: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
    return parsed.schema === 1 && typeof parsed.baselines === "object"
      ? parsed
      : structuredClone(EMPTY_BASELINE);
  } catch {
    return structuredClone(EMPTY_BASELINE);
  }
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Pin a measurement as the baseline for its platform. The running platform's
 * entry is replaced wholesale (scales are compared as a set), other platforms
 * are preserved, and keys are written in a stable order for reviewable diffs.
 */
export function updateBaseline(path: string, measurement: PerfMeasurement): void {
  const file = loadBaseline(path);
  const scales: Record<string, BaselineScale> = {};
  for (const scale of [...measurement.scales].sort((a, b) => a.scale.localeCompare(b.scale))) {
    const stages: Record<string, number> = {};
    for (const stage of [...scale.stages].sort((a, b) => a.stage.localeCompare(b.stage))) {
      stages[stage.stage] = roundMs(gatedMs(stage));
    }
    scales[scale.scale] = { files: scale.files, warmup: scale.warmup, runs: scale.runs, stages };
  }
  const sorted: Record<string, BaselineEntry> = {};
  for (const id of Object.keys(file.baselines).sort()) sorted[id] = file.baselines[id]!;
  sorted[platformId(measurement.platform)] = { platform: measurement.platform, scales };

  const next: BaselineFile = { schema: 1, baselines: sorted };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

// --- comparison ---------------------------------------------------------------

/** Per-stage comparison rows for one scale. Stages absent from the baseline are skipped. */
export function compareScale(
  measured: ScaleMeasurement,
  baseline: BaselineScale | undefined,
  factor: number,
): StageComparison[] {
  const rows: StageComparison[] = [];
  for (const stage of measured.stages) {
    const baselineMs = baseline?.stages[stage.stage];
    if (baselineMs === undefined) continue;
    const gated = gatedMs(stage);
    // Decide on the ratio we print, not `gated > baseline * factor`: `1.15` is
    // not exactly representable, so the product form would fail a run sitting
    // exactly on the limit (100 * 1.15 === 114.99999999999999).
    const ratio =
      baselineMs === 0
        ? gated === 0
          ? 1
          : Number.POSITIVE_INFINITY
        : gated / baselineMs;
    rows.push({
      stage: stage.stage,
      medianMs: stage.medianMs,
      gatedMs: gated,
      baselineMs,
      ratio,
      // Every measured stage is gated (spec §11): the minimum across runs over
      // baseline × 1.15 fails. The median is reported but not gated.
      ok: !(ratio > factor),
    });
  }
  return rows;
}

/** Compare a whole measurement against the committed baseline for its platform. */
export function evaluate(
  measurement: PerfMeasurement,
  baseline: BaselineFile,
  factor: number = DEFAULT_THRESHOLD,
): PerfVerdict {
  const entry = baseline.baselines[platformId(measurement.platform)];
  if (entry === undefined) return { ok: false, missing: true, failures: [] };

  const failures: StageFailure[] = [];
  for (const scale of measurement.scales) {
    for (const row of compareScale(scale, entry.scales[scale.scale], factor)) {
      if (!row.ok) {
        failures.push({
          scale: scale.scale,
          stage: row.stage,
          gatedMs: row.gatedMs,
          baselineMs: row.baselineMs,
          ratio: row.ratio,
        });
      }
    }
  }
  return { ok: failures.length === 0, missing: false, failures };
}

// --- measurement --------------------------------------------------------------

export interface StageContext {
  scale: string;
  corpusDir: string;
  configPath: string;
  /** Absolute corpus file paths. */
  files: string[];
  workers: number;
  batchSize: number;
  serial: boolean;
  /**
   * The lint stage's recorded result, for the engine stages. The message list is
   * what scan/plan/apply will consume, so they never re-lint (spec §7, §11).
   */
  lint?: RunPoolResult;
  /** Memoized file texts, read once so the engine stages measure engine time. */
  texts?: Map<string, string>;
  /** The scan stage's per-file targets, consumed by the plan stage. */
  suppressTargets?: Map<string, SuppressTarget[]>;
  /** The plan stage's per-file edits, consumed by the apply stage. */
  suppressEdits?: Map<string, PlannedEdit[]>;
}

/** Files with at least one message: the denominator for engine µs/file. */
function filesWithMessages(context: StageContext): number {
  let count = 0;
  for (const outcome of context.lint?.files ?? []) if (outcome.messages.length > 0) count += 1;
  return count;
}

/** Read every linted file's text once, memoized across the engine stages. */
function corpusTexts(context: StageContext): Map<string, string> {
  if (context.texts !== undefined) return context.texts;
  const texts = new Map<string, string>();
  for (const outcome of context.lint?.files ?? []) {
    texts.set(outcome.filePath, readFileSync(outcome.filePath, "utf8"));
  }
  context.texts = texts;
  return texts;
}

export interface PerfStage {
  name: string;
  run: (context: StageContext) => Promise<void>;
}

/**
 * A per-action strategy stage: run one action's per-file strategy over the
 * **already-linted** corpus (spec §11). It never re-lints — it consumes
 * `context.lint`'s messages and the memoized file text — so the stage measures
 * the action's own scan/plan/apply work on the main thread.
 */
function actionStage(name: string, action: Action, params: StrategyParams): PerfStage {
  return {
    name: `action:${name}`,
    async run(context) {
      const lint = context.lint;
      if (lint === undefined) return;
      const texts = corpusTexts(context);
      for (const outcome of lint.files) {
        const text = texts.get(outcome.filePath);
        if (text === undefined) continue;
        runActionForFile({
          action,
          params,
          filePath: outcome.filePath,
          text,
          messages: outcome.messages,
        });
      }
    },
  };
}

/**
 * The measured stages, in order. Each `run` is the whole stage body; the runner
 * wraps it with warmup, repetition and timing.
 *
 * The engine stages (`scan` / `plan` / `apply`) and the per-action `action:*`
 * stages operate per file over `context.lint.files[...].messages` and the file
 * text, on the main thread — no pool construction, no re-lint (spec §11). `lint`
 * stays first because they consume its recorded result. `report` renders the run
 * report from the same ledger. `scan-full` and the non-suppress `action:*` stages
 * touch **every** corpus file, not just the ones with messages (spec §7).
 */
export function createStages(): PerfStage[] {
  return [
    {
      name: "discover",
      async run(context) {
        await discover({ target: context.corpusDir, extensions: [...DEFAULT_EXTENSIONS] });
      },
    },
    {
      name: "lint",
      async run(context) {
        context.lint = await runPool({
          files: context.files,
          configPath: context.configPath,
          cwd: context.corpusDir,
          action: LINT_ACTION,
          params: {},
          mode: "dry-run",
          workers: context.workers,
          batchSize: context.batchSize,
          serial: context.serial,
        });
      },
    },
    {
      name: "scan",
      async run(context) {
        const lint = context.lint;
        if (lint === undefined) return;
        const texts = corpusTexts(context);
        const targets = new Map<string, SuppressTarget[]>();
        for (const outcome of lint.files) {
          if (outcome.messages.length === 0) continue;
          const text = texts.get(outcome.filePath);
          if (text === undefined) continue;
          targets.set(outcome.filePath, scanSuppressFile(text.split("\n"), outcome.messages));
        }
        context.suppressTargets = targets;
      },
    },
    {
      name: "plan",
      async run(context) {
        const lint = context.lint;
        const targets = context.suppressTargets;
        if (lint === undefined || targets === undefined) return;
        const planned = new Map<string, PlannedEdit[]>();
        for (const outcome of lint.files) {
          const fileTargets = targets.get(outcome.filePath);
          if (fileTargets === undefined) continue;
          planned.set(outcome.filePath, planSuppressEdits(fileTargets, { reason: "perf" }).edits);
        }
        context.suppressEdits = planned;
      },
    },
    {
      name: "apply",
      async run(context) {
        const lint = context.lint;
        const planned = context.suppressEdits;
        if (lint === undefined || planned === undefined) return;
        const texts = corpusTexts(context);
        for (const outcome of lint.files) {
          const edits = planned.get(outcome.filePath);
          if (edits === undefined || edits.length === 0) continue;
          const text = texts.get(outcome.filePath);
          if (text === undefined) continue;
          const lines = text.split("\n");
          applySuppressEdits(lines, edits);
          lines.join("\n");
        }
      },
    },
    {
      name: "scan-full",
      async run(context) {
        // The shared full-file scan over all four forms (spec §7): the work the
        // non-lazy actions (remove/replace/cleanup/inventory) pay. Every linted
        // file is scanned, not just the ones with messages.
        const texts = corpusTexts(context);
        for (const text of texts.values()) scanDirectives(text.split("\n"));
      },
    },
    {
      name: "report",
      async run(context) {
        // The report stage (spec §11): assemble and render the run report from
        // the lint ledger. HTML is the default format (spec §4), so that is what
        // the gate measures.
        const lint = context.lint;
        if (lint === undefined) return;
        const edits = orderEdits(lint.files.flatMap((outcome) => outcome.edits));
        const meta: RunMeta = {
          tool: "pocket-comb",
          version: VERSION,
          action: LINT_ACTION,
          configPath: context.configPath,
          configHash: "",
          target: context.corpusDir,
          startedAt: "1970-01-01T00:00:00.000Z",
          durationMs: 0,
          dryRun: true,
          workers: context.workers,
          counts: {
            discovered: context.files.length,
            linted: lint.files.length,
            dropped: lint.dropped.length,
            touched: lint.files.filter((outcome) => outcome.changed).length,
          },
        };
        renderReport(buildRunReport(meta, edits), "html");
      },
    },
    actionStage("suppress", "suppress", {}),
    actionStage("remove", "remove", { rules: ["no-console", "no-unused-vars"] }),
    actionStage("replace", "replace", { from: "no-console", to: "no-alert" }),
    actionStage("cleanup", "cleanup", { rules: ["no-console", "no-unused-vars"] }),
    {
      name: "action:inventory",
      async run(context) {
        // Inventory never lints and has no `runActionForFile` strategy; its real
        // work is the census scan, so measure that directly over every file.
        const texts = corpusTexts(context);
        for (const text of texts.values()) censusFileScan(text.split("\n"));
      },
    },
  ];
}

export interface MeasureScaleOptions {
  scale: string;
  files: number;
  seed?: number;
  corpusDir: string;
  configPath?: string;
  workers?: number;
  batchSize?: number;
  serial?: boolean;
  warmup?: number;
  runs?: number;
  /**
   * Diagnostic/test seam: sleep this many ms inside a named stage's measured
   * region. Used to prove the 1.15 tripwire actually fires; production leaves it
   * unset.
   */
  stageDelays?: Record<string, number>;
  onStage?: (stage: StageResult) => void;
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1] ?? 0;
}

/**
 * Force a garbage collection before each measured sample when the process allows
 * it (`node --expose-gc`; `npm run test:perf` passes it). This is the harness's
 * jitter control (spec §11): the allocation-heavy stages otherwise inherit the
 * previous stage's garbage and pay a major GC **inside** the measured region,
 * which could double the 0.3 ms `plan` stage in an unlucky process. Cleaning the
 * heap before the timed region keeps each sample honest without inflating it,
 * and — unlike a calibrated repeat loop — it does not manufacture the very GC
 * pressure it would then attribute to the stage. A no-op when `global.gc` is
 * absent (e.g. the in-process harness unit tests).
 */
function collectGarbage(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

/**
 * Measure one stage: warmup, then `runs` single-execution samples, each preceded
 * by a forced GC. The **median** is reported and the **minimum** is what the gate
 * compares (see `gatedMs`); single executions keep the allocation-heavy stages
 * from paying GCs they would not pay in production, which is what made the
 * sub-millisecond `plan` stage flaky under a calibrated repeat loop.
 */
async function measureStage(
  name: string,
  run: () => Promise<void>,
  options: { warmup: number; runs: number; delayMs: number },
): Promise<StageResult> {
  for (let i = 0; i < options.warmup; i++) await run();

  const runsMs: number[] = [];
  for (let i = 0; i < options.runs; i++) {
    collectGarbage();
    const start = nowMs();
    await run();
    if (options.delayMs > 0) await sleep(options.delayMs);
    runsMs.push(nowMs() - start);
  }
  return {
    stage: name,
    runsMs,
    medianMs: median(runsMs),
    minMs: runsMs.length === 0 ? 0 : Math.min(...runsMs),
    maxMs: runsMs.length === 0 ? 0 : Math.max(...runsMs),
  };
}

/**
 * Stages whose µs/file is over the files **with messages** (the suppress hot
 * path only touches those, spec §6.1).
 */
const MESSAGE_FILE_STAGES = new Set(["scan", "plan", "apply", "action:suppress"]);

/**
 * Stages whose per-file cost is over **every** corpus file, not just the files
 * with lint messages: the full-file scan (and the actions built on it) touch
 * them all (spec §7).
 */
const ALL_FILE_STAGES = new Set([
  "scan-full",
  "action:remove",
  "action:replace",
  "action:cleanup",
  "action:inventory",
]);

/** Generate the corpus, then measure every stage: warmup, measured runs, median reported. */
export async function measureScale(options: MeasureScaleOptions): Promise<ScaleMeasurement> {
  const seed = options.seed ?? DEFAULT_SEED;
  const warmup = options.warmup ?? DEFAULT_WARMUP;
  const runs = options.runs ?? DEFAULT_RUNS;
  const corpus = generateCorpus({ seed, files: options.files, out: options.corpusDir });
  const files = corpus.manifest.entries.map((entry) => join(corpus.dir, entry.name));

  const context: StageContext = {
    scale: options.scale,
    corpusDir: corpus.dir,
    configPath: options.configPath ?? CORPUS_CONFIG_PATH,
    files,
    workers: Math.max(1, Math.floor(options.workers ?? defaultWorkerCount())),
    batchSize: Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE)),
    serial: options.serial ?? false,
  };

  const stages: StageResult[] = [];
  for (const stage of createStages()) {
    const result = await measureStage(stage.name, () => stage.run(context), {
      warmup,
      runs,
      delayMs: options.stageDelays?.[stage.name] ?? 0,
    });
    if (MESSAGE_FILE_STAGES.has(result.stage)) {
      const messageFiles = filesWithMessages(context);
      if (messageFiles > 0) result.perFileUs = (result.medianMs * 1000) / messageFiles;
    } else if (ALL_FILE_STAGES.has(result.stage) && context.files.length > 0) {
      result.perFileUs = (result.medianMs * 1000) / context.files.length;
    }
    stages.push(result);
    options.onStage?.(result);
  }

  return { scale: options.scale, files: files.length, warmup, runs, stages };
}

// --- CLI ----------------------------------------------------------------------

export interface PerfIo {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: PerfIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

interface PerfArgs {
  scales: Array<{ name: string; files: number }>;
  seed: number;
  baseline: string;
  corpusDir?: string;
  updateBaseline: boolean;
  requireBaseline: boolean;
  json: boolean;
  threshold: number;
  warmup: number;
  runs: number;
  workers: number;
  batchSize: number;
  serial: boolean;
  help: boolean;
}

/**
 * The stress scale's file count is env-configurable as well as flag-selectable
 * (spec §11: "stress 20,000 (flag/env)"): set this to resize the stress scale
 * without touching the committed default.
 */
export const STRESS_FILES_ENV = "POCKET_COMB_PERF_STRESS_FILES";

/** The named scale counts, with the stress size overridable by env (spec §11). */
export function scaleCounts(): Record<string, number> {
  const env = Number(process.env[STRESS_FILES_ENV]);
  const stress = Number.isFinite(env) && env >= 1 ? Math.floor(env) : STRESS_FILE_COUNT;
  return { default: DEFAULT_FILE_COUNT, stress };
}

const USAGE = `Usage: npm run test:perf -- [flags]

The separate perf timing suite (never part of \`npm test\`). WARMS UP, takes
measured runs per stage, and fails when **any** stage's minimum across runs
exceeds the committed platform baseline by more than 15% (the median is reported
too; no stage is exempt).

Flags:
  --scales <a,b>        scales to measure (default: default,stress)
  --files <n>           measure a single ad-hoc scale of <n> files
  --seed <n>            corpus seed (default ${DEFAULT_SEED})
  --baseline <path>     baseline JSON (default perf/baseline.json)
  --corpus-dir <path>   where to generate the corpus (default OS temp dir)
  --update-baseline     re-pin this platform's baseline, then exit
  --require-baseline    treat a missing platform baseline as a failure
  --threshold <x>       regression factor (default ${DEFAULT_THRESHOLD})
  --warmup <n>          warmup runs per stage (default ${DEFAULT_WARMUP})
  --runs <n>            measured runs per stage (default ${DEFAULT_RUNS})
  --workers <n>         pool size (default ceil(cores x 0.75))
  --batch-size <n>      files per task (default ${DEFAULT_BATCH_SIZE})
  --serial              single in-process instance (no pool)
  --json                print the raw measurement JSON
  --help                this message

Env:
  ${STRESS_FILES_ENV}  override the stress scale's file count (default ${STRESS_FILE_COUNT})`;

function parseArgs(argv: string[]): PerfArgs {
  let scalesArg = "default,stress";
  let filesArg: number | undefined;
  let seed = DEFAULT_SEED;
  let baseline = BASELINE_PATH;
  let corpusDir: string | undefined;
  let updateBase = false;
  let requireBaseline = false;
  let json = false;
  let threshold = DEFAULT_THRESHOLD;
  let warmup = DEFAULT_WARMUP;
  let runs = DEFAULT_RUNS;
  let workers = defaultWorkerCount(availableParallelism());
  let batchSize = DEFAULT_BATCH_SIZE;
  let serial = false;
  let help = false;

  const int = (flag: string, raw: string | undefined): number => {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${flag} must be a number`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--scales":
        scalesArg = argv[++i] ?? "";
        break;
      case "--files":
        filesArg = int(arg, argv[++i]);
        break;
      case "--seed":
        seed = int(arg, argv[++i]);
        break;
      case "--baseline":
        baseline = argv[++i] ?? baseline;
        break;
      case "--corpus-dir":
        corpusDir = argv[++i];
        break;
      case "--update-baseline":
        updateBase = true;
        break;
      case "--require-baseline":
        requireBaseline = true;
        break;
      case "--json":
        json = true;
        break;
      case "--threshold":
        threshold = int(arg, argv[++i]);
        break;
      case "--warmup":
        warmup = int(arg, argv[++i]);
        break;
      case "--runs":
        runs = int(arg, argv[++i]);
        break;
      case "--workers":
        workers = int(arg, argv[++i]);
        break;
      case "--batch-size":
        batchSize = int(arg, argv[++i]);
        break;
      case "--serial":
        serial = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  let scales: Array<{ name: string; files: number }>;
  if (filesArg !== undefined) {
    if (filesArg < 1) throw new Error("--files must be a positive integer");
    scales = [{ name: "custom", files: Math.floor(filesArg) }];
  } else {
    scales = scalesArg
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => {
        const files = scaleCounts()[name];
        if (files === undefined) throw new Error(`unknown scale: ${name} (default|stress)`);
        return { name, files };
      });
    if (scales.length === 0) throw new Error("--scales must name at least one scale");
  }

  return {
    scales,
    seed,
    baseline,
    corpusDir,
    updateBaseline: updateBase,
    requireBaseline,
    json,
    threshold,
    warmup,
    runs,
    workers,
    batchSize,
    serial,
    help,
  };
}

const fmt = (value: number): string => value.toFixed(2).padStart(9);

/**
 * The suite entry point. Returns the process exit code: 0 green, 1 regression,
 * 2 a usage error. Testable in-process via `io`.
 */
export async function runPerfCli(argv: string[], io: PerfIo = consoleIo): Promise<number> {
  let args: PerfArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }

  const platform = platformKey();
  const runs = args.runs;
  io.out(`pocket-comb perf harness — ${platformId(platform)}`);
  io.out(
    `methodology: warmup ${args.warmup}, ${runs} measured runs, gated on the ` +
      `minimum across runs (median reported)` +
      (args.serial ? ", serial" : `, pool ${args.workers} x batch ${args.batchSize}`),
  );

  const measurement: PerfMeasurement = {
    platform,
    measuredAt: new Date().toISOString(),
    scales: [],
  };

  for (const scale of args.scales) {
    const corpusDir = args.corpusDir ?? defaultCorpusDir(args.seed, scale.files);
    io.out(`corpus ${scale.name}: ${scale.files} files at ${corpusDir}`);
    const result = await measureScale({
      scale: scale.name,
      files: scale.files,
      seed: args.seed,
      corpusDir,
      configPath: CORPUS_CONFIG_PATH,
      workers: args.workers,
      batchSize: args.batchSize,
      serial: args.serial,
      warmup: args.warmup,
      runs,
      onStage: (stage) =>
        io.out(
          `  ${stage.stage.padEnd(10)} median ${fmt(stage.medianMs)} ms  ` +
            `(min ${stage.minMs.toFixed(2)}, max ${stage.maxMs.toFixed(2)})` +
            (stage.perFileUs === undefined ? "" : `  ${stage.perFileUs.toFixed(3)} µs/file`),
        ),
    });
    measurement.scales.push(result);
  }

  if (args.json) io.out(JSON.stringify(measurement, null, 2));

  if (args.updateBaseline) {
    updateBaseline(args.baseline, measurement);
    io.out(`baseline updated: ${args.baseline}`);
    io.out(`platform: ${platformId(platform)}`);
    return 0;
  }

  const baseline = loadBaseline(args.baseline);
  const entry = baseline.baselines[platformId(platform)];
  if (entry === undefined) {
    io.out(`no committed baseline for this platform in ${args.baseline}`);
    io.out("pin one deliberately with: npm run test:perf -- --update-baseline");
    return args.requireBaseline ? 1 : 0;
  }

  let failed = false;
  for (const scale of measurement.scales) {
    for (const row of compareScale(scale, entry.scales[scale.scale], args.threshold)) {
      const verdict = row.ok ? "ok" : "FAIL";
      if (!row.ok) failed = true;
      io.out(
        `  ${scale.scale}/${row.stage} min ${fmt(row.gatedMs)} ms  ` +
          `baseline ${fmt(row.baselineMs)} ms  ratio ${row.ratio.toFixed(2)}  ${verdict}`,
      );
    }
  }

  if (failed) {
    io.out(`perf: FAIL (regression > x${args.threshold} vs committed baseline)`);
    return 1;
  }
  io.out(`perf: PASS (within x${args.threshold} of committed baseline)`);
  return 0;
}

const isEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  process.exitCode = await runPerfCli(process.argv.slice(2));
}
