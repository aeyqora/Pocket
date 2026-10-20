import { DEFAULT_EXTENSIONS, discover } from "../discovery.js";
import { OperationalError } from "../errors.js";
import { buildRunReport, orderEdits, type RunMeta } from "../ledger.js";
import { PoolRecoveryError, runPool, type RunPoolResult } from "../pool.js";
import {
  emitReport,
  resolveReportOptions,
  type ResolvedReportOptions,
} from "../report/index.js";
import { VERSION } from "../version.js";
import {
  createSpinner,
  summarizeImpact,
  summarizeRun,
  writeCompletion,
  writeImpactSummary,
  type ImpactSummary,
} from "../ui.js";
import type { ActionContext } from "./action.js";
import type { Action, BatchOutcome, JsonValue } from "../types.js";

/**
 * The per-action differences the shared runner cannot infer: extra human output
 * after the impact summary, the report's follow-on hint, and the dry-run exit
 * rule. Every mutating action supplies these; the pipeline around them — config
 * discovery, the pool, the impact/completion lines, `RunMeta`, report emission,
 * and the partial-ledger-on-recovery path — is identical, so it lives here once
 * (spec §7's "one pipeline for six actions").
 */
export interface ActionRunHooks {
  /**
   * Extra human output after the impact summary and before the completion line
   * (e.g. remove/cleanup's not-actionable notes, replace's cleanup hint). `hint`
   * is whatever `hint` returned for this impact.
   */
  afterImpact?: (
    output: NodeJS.WritableStream,
    outcomes: readonly BatchOutcome[],
    hint: string | undefined,
  ) => void;
  /** The report's follow-on hint, when the impact warrants one. */
  hint?: (impact: ImpactSummary) => string | undefined;
  /** Whether a dry run with this impact exits 1. Default: `impact.edits > 0`. */
  exitOnImpact?: (impact: ImpactSummary) => boolean;
}

export interface ActionRunOptions {
  action: Action;
  /** The action's strategy params (cloneable JSON). */
  params: JsonValue;
  /** `suppress --fix-first`: run the fix phase first, in each worker. */
  fixFirst?: boolean;
  hooks?: ActionRunHooks;
}

/** Where human-facing output and the report go, resolved once per run. */
export interface ResolvedOutput {
  report: ResolvedReportOptions;
  humanOutput: NodeJS.WritableStream;
}

/**
 * Resolve the report format/destination (spec §13) and pick where human-facing
 * output goes: when the report streams to stdout (`--out -`), the impact and
 * completion lines move to stderr so the piped report stays parseable.
 */
export function resolveOutput(context: ActionContext): ResolvedOutput {
  const { parsed, config, io } = context;
  const report = resolveReportOptions({
    formatFlag: parsed.format,
    outFlag: parsed.out,
    noReport: parsed.noReport,
    setting: config.report,
    cwd: io.cwd,
  });
  return { report, humanOutput: report.enabled && report.out === "-" ? io.stderr : io.output };
}

export interface BuildMetaOptions {
  action: Action;
  startedAt: string;
  durationMs: number;
  dryRun: boolean;
  workers: number;
  /** Files discovery found (the `discovered` count). */
  discovered: number;
  /** Per-file outcomes; `linted` and `touched` derive from them. */
  outcomes: readonly BatchOutcome[];
  dropped: number;
}

/** Build the run's `RunMeta` from the resolved config and the pool result. */
export function buildMeta(context: ActionContext, options: BuildMetaOptions): RunMeta {
  return {
    tool: "pocket-comb",
    version: VERSION,
    action: options.action,
    configPath: context.config.configPath,
    configHash: context.config.configHash,
    target: context.config.targetRoot,
    startedAt: options.startedAt,
    durationMs: options.durationMs,
    dryRun: options.dryRun,
    workers: options.workers,
    counts: {
      discovered: options.discovered,
      linted: options.outcomes.length,
      dropped: options.dropped,
      touched: options.outcomes.filter((outcome) => outcome.changed).length,
    },
  };
}

/**
 * Write the partial ledger after an unrecoverable worker failure (spec §8): the
 * second failure is exit 2, but the ledger so far is preserved. The resolved
 * format/destination is respected; it is written even under `--no-report`,
 * because the spec's whole point is that the partial ledger survives.
 */
function writePartialReport(
  context: ActionContext,
  options: {
    action: Action;
    report: ResolvedReportOptions;
    startedAt: string;
    durationMs: number;
    dryRun: boolean;
    discovered: number;
    partial: RunPoolResult;
  },
): void {
  const { partial } = options;
  const meta = buildMeta(context, {
    action: options.action,
    startedAt: options.startedAt,
    durationMs: options.durationMs,
    dryRun: options.dryRun,
    workers: partial.workers,
    discovered: options.discovered,
    outcomes: partial.files,
    dropped: partial.dropped.length,
  });
  const edits = orderEdits(partial.files.flatMap((outcome) => outcome.edits));
  emitReport({
    data: buildRunReport(meta, edits),
    format: options.report.format,
    out: options.report.out,
    stdout: context.io.output,
  });
  if (options.report.out !== "-") {
    context.io.stderr.write(`partial ledger written: ${options.report.out}\n`);
  }
}

/**
 * The shared mutating-action pipeline. Discover, run the pool (the owning
 * workers write on `--apply`), print the impact summary, any action-specific
 * notes, the completion confirmation, and — unless `--no-report` — the report.
 * A dry run with impact exits 1 (the CI probe); an apply run exits 0.
 *
 * The report resolves after the run: `context.resolveReport` (the wizard's
 * prompt, spec §5 step 7) when present, otherwise `resolveOutput`'s earlier
 * answer. Either way `emitReport` runs last, so the impact summary precedes any
 * report prompt (spec §13).
 *
 * On an unrecoverable worker failure (`PoolRecoveryError`) the partial ledger is
 * written before the error propagates to the CLI's exit-2 handler (spec §8).
 */
export async function runActionPipeline(
  context: ActionContext,
  options: ActionRunOptions,
): Promise<number> {
  const { parsed, config, io } = context;
  const mode = parsed.mode ?? "dry-run";
  const dryRun = mode === "dry-run";
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const extensions = parsed.extensions ?? [...DEFAULT_EXTENSIONS];
  const { files } = await discover({ target: config.targetRoot, extensions });
  if (files.length === 0) {
    throw new OperationalError(`no files matched under ${config.targetRoot}`);
  }

  const { report: carriedReport, humanOutput } = resolveOutput(context);
  const spinner = createSpinner({ output: io.stderr, tty: io.tty });

  let result: RunPoolResult;
  try {
    result = await runPool({
      files,
      configPath: config.configPath,
      cwd: config.targetRoot,
      action: options.action,
      params: options.params,
      mode,
      ...(options.fixFirst === true ? { fixFirst: true } : {}),
      ...(parsed.workers !== null ? { workers: parsed.workers } : {}),
      ...(parsed.batchSize !== null ? { batchSize: parsed.batchSize } : {}),
      serial: parsed.serial,
      onProgress: (progress) => spinner.update(progress),
    });
  } catch (err) {
    if (err instanceof PoolRecoveryError) {
      writePartialReport(context, {
        action: options.action,
        report: carriedReport,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        dryRun,
        discovered: files.length,
        partial: err.partial,
      });
    }
    throw err;
  } finally {
    spinner.stop();
  }

  const outcomes = result.files;
  const impact = summarizeImpact(outcomes);
  writeImpactSummary(humanOutput, impact, dryRun);

  const hint = options.hooks?.hint?.(impact);
  options.hooks?.afterImpact?.(humanOutput, outcomes, hint);

  const durationMs = Date.now() - startedAtMs;
  const completion = summarizeRun(outcomes, durationMs);
  writeCompletion(humanOutput, completion);

  // The report resolves here — after the run and the impact/completion lines —
  // so a wizard prompt (spec §5 step 7) lands after the impact summary (§13).
  // Without a resolver this is exactly `resolveOutput`'s earlier answer.
  const report =
    context.resolveReport !== undefined ? await context.resolveReport() : carriedReport;

  if (report.enabled) {
    const edits = orderEdits(outcomes.flatMap((outcome) => outcome.edits));
    const meta = buildMeta(context, {
      action: options.action,
      startedAt,
      durationMs,
      dryRun,
      workers: result.workers,
      discovered: files.length,
      outcomes,
      dropped: result.dropped.length,
    });
    emitReport({
      data: buildRunReport(meta, edits, hint),
      format: report.format,
      out: report.out,
      stdout: io.output,
    });
  }

  const exitOnImpact = options.hooks?.exitOnImpact ?? ((value: ImpactSummary) => value.edits > 0);
  return dryRun && exitOnImpact(impact) ? 1 : 0;
}
