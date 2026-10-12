/**
 * The separate perf timing suite (spec §11) — the deterioration tripwire.
 *
 * Methodology: warm up, then take 5 measured runs per stage and compare medians
 * against a committed baseline **keyed by platform** (`os` + CPU model + Node
 * version), failing when a median exceeds the baseline by more than 15%
 * (`--threshold`). `--update-baseline` re-pins deliberately; it is never part of
 * a normal run.
 *
 * The stages start with `discover` and `lint`. The engine stages (scan / plan /
 * apply) land with the engine and append to `createStages()` — the extension
 * point is marked there; each will consume the lint stage's recorded messages so
 * it measures engine time only.
 *
 * This module is wired to `npm run test:perf`; it must never run under
 * `npm test`, which is correctness-only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, platform as osPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_EXTENSIONS, discover } from "../src/discovery.js";
import { DEFAULT_BATCH_SIZE, defaultWorkerCount, runPool } from "../src/pool.js";
import type { RunPoolResult } from "../src/pool.js";
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

/** Default regression factor: fail when a median exceeds baseline × 1.15. */
export const DEFAULT_THRESHOLD = 1.15;

/**
 * Stages whose committed baseline is below this many milliseconds are measured
 * and reported but **not gated**. A 5ms walk has no stable ±15%: on this machine
 * the default-scale discover stage ranged 5.1–6.1 ms across fresh processes
 * (a 1.19 ratio) purely from filesystem/timer jitter, and no warmup removed it.
 * The alternative — a gate that flakes — is a tripwire no one trusts. Larger
 * stages (stress discover ~50 ms, lint at both scales) are gated normally.
 */
export const MIN_GATED_BASELINE_MS = 10;

/** Measured runs after warmup (spec §11). */
export const DEFAULT_RUNS = 5;

/**
 * Warmup runs before measuring. The spec pins only "after warmup"; 5 is chosen
 * empirically: the pool rebuilds its workers every measured run, so a cold first
 * process inflates the first stage's median past the 1.15 gate at lower counts
 * (measured spread across fresh processes was ~28% at warmup 3, ~7% at warmup 5).
 */
export const DEFAULT_WARMUP = 5;

/**
 * Measured runs used when *pinning* a baseline (`--update-baseline`). A single
 * 5-run median is itself a noisy sample; pinning from 15 runs gives a central
 * reference, so a later comparison run has to be genuinely slower to trip the
 * gate. Normal comparison runs still use the spec's 5 (see `DEFAULT_RUNS`).
 */
export const BASELINE_RUNS = 15;

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
  /** stage name -> median ms. */
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

export interface StageComparison {
  stage: string;
  medianMs: number;
  baselineMs: number;
  ratio: number;
  /** False when the baseline is below `MIN_GATED_BASELINE_MS` (reported, not gated). */
  gated: boolean;
  ok: boolean;
}

export interface StageFailure {
  scale: string;
  stage: string;
  medianMs: number;
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
      stages[stage.stage] = roundMs(stage.medianMs);
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
    // Decide on the ratio we print, not `median > baseline * factor`: `1.15` is
    // not exactly representable, so the product form would fail a run sitting
    // exactly on the limit (100 * 1.15 === 114.99999999999999).
    const ratio =
      baselineMs === 0
        ? stage.medianMs === 0
          ? 1
          : Number.POSITIVE_INFINITY
        : stage.medianMs / baselineMs;
    const gated = baselineMs >= MIN_GATED_BASELINE_MS;
    rows.push({
      stage: stage.stage,
      medianMs: stage.medianMs,
      baselineMs,
      ratio,
      gated,
      ok: !gated || !(ratio > factor),
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
          medianMs: row.medianMs,
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
}

export interface PerfStage {
  name: string;
  run: (context: StageContext) => Promise<void>;
}

/**
 * The measured stages, in order. Each `run` is the whole stage body; the runner
 * wraps it with warmup, repetition and timing.
 *
 * Ticket 05 extension point: append the engine stages here.
 *  - `scan` / `plan` / `apply` operate per file over `context.lint.files[...].messages`
 *    and the file text, on the main thread — no pool construction.
 *  - Record µs/file on the returned `StageResult.perFileUs` (spec §11's micro-timings);
 *    divide accumulated µs by the number of files with messages.
 *  - Keep the `lint` stage first: the engine stages depend on its recorded result.
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

async function measureStage(
  name: string,
  run: () => Promise<void>,
  options: { warmup: number; runs: number; delayMs: number },
): Promise<StageResult> {
  for (let i = 0; i < options.warmup; i++) await run();
  const runsMs: number[] = [];
  for (let i = 0; i < options.runs; i++) {
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

/** Generate the corpus, then measure every stage: warmup, 5 runs, median. */
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
  /** True when `--runs` was passed; `--update-baseline` otherwise raises the default. */
  runsExplicit: boolean;
  workers: number;
  batchSize: number;
  serial: boolean;
  help: boolean;
}

const SCALE_COUNTS: Record<string, number> = {
  default: DEFAULT_FILE_COUNT,
  stress: STRESS_FILE_COUNT,
};

const USAGE = `Usage: npm run test:perf -- [flags]

The separate perf timing suite (never part of \`npm test\`). WARMS UP, takes 5
measured runs per stage, and fails when a stage median exceeds the committed
platform baseline by more than 15%.

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
  --runs <n>            measured runs per stage (default ${DEFAULT_RUNS}; ${BASELINE_RUNS} when pinning)
  --workers <n>         pool size (default ceil(cores x 0.75))
  --batch-size <n>      files per task (default ${DEFAULT_BATCH_SIZE})
  --serial              single in-process instance (no pool)
  --json                print the raw measurement JSON
  --help                this message`;

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
  let runsExplicit = false;
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
        runsExplicit = true;
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
        const files = SCALE_COUNTS[name];
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
    runsExplicit,
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
  const runs = args.updateBaseline && !args.runsExplicit ? BASELINE_RUNS : args.runs;
  io.out(`pocket-comb perf harness — ${platformId(platform)}`);
  io.out(
    `methodology: warmup ${args.warmup}, ${runs} measured runs, median per stage` +
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
            `(min ${stage.minMs.toFixed(2)}, max ${stage.maxMs.toFixed(2)})`,
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
      const verdict = !row.gated ? "info" : row.ok ? "ok" : "FAIL";
      if (!row.ok) failed = true;
      io.out(
        `  ${scale.scale}/${row.stage} median ${fmt(row.medianMs)} ms  ` +
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
