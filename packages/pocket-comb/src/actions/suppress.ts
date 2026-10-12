import { DEFAULT_EXTENSIONS, discover } from "../discovery.js";
import { OperationalError } from "../errors.js";
import { buildRunReport, orderEdits, type RunMeta } from "../ledger.js";
import { runPool } from "../pool.js";
import { emitReport, resolveReportOptions } from "../report/index.js";
import { VERSION } from "../version.js";
import {
  createSpinner,
  summarizeImpact,
  summarizeRun,
  writeCompletion,
  writeImpactSummary,
} from "../ui.js";
import type { ActionContext } from "./action.js";
import type { SuppressParams } from "../engine.js";
import type { JsonValue } from "../types.js";

/**
 * `pocket-comb suppress` — the flagship command end-to-end (spec §6.1).
 *
 * Resolve the config/target, discover files, run the shared pipeline through the
 * worker pool (the owning workers write on `--apply`), print the impact summary
 * and the completion confirmation, then emit the post-run report (spec §13)
 * unless `--no-report` asked for none.
 *
 * Dry run is the non-interactive default: it prints what the run *would* change
 * and exits 1 when there is impact — the CI probe — 0 when there is none.
 */
export async function runSuppress(context: ActionContext): Promise<number> {
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

  // The suppress strategy's params (spec §6.1). `reuseBlocks` is read by the
  // engine; `fixFirst` is a pool-level phase (fix → re-lint → suppress) and is
  // passed to `runPool` below, but the wire shape keeps the declared field.
  const params: SuppressParams = {};
  if (parsed.reason !== null) params.reason = parsed.reason;
  if (parsed.reuseBlocks) params.reuseBlocks = true;
  if (parsed.fixFirst) params.fixFirst = true;

  const spinner = createSpinner({ output: io.stderr, tty: io.tty });
  const result = await runPool({
    files,
    configPath: config.configPath,
    cwd: config.targetRoot,
    action: "suppress",
    params: params as unknown as JsonValue,
    mode,
    ...(parsed.fixFirst ? { fixFirst: true } : {}),
    ...(parsed.workers !== null ? { workers: parsed.workers } : {}),
    ...(parsed.batchSize !== null ? { batchSize: parsed.batchSize } : {}),
    serial: parsed.serial,
    onProgress: (progress) => spinner.update(progress),
  }).finally(() => spinner.stop());

  const outcomes = result.files;

  // Resolve the report before the human-facing output: when the report streams to
  // stdout (`--out -`), the impact/completion lines move to stderr so the piped
  // report stays parseable (spec §13's census piping shape).
  const report = resolveReportOptions({
    formatFlag: parsed.format,
    outFlag: parsed.out,
    noReport: parsed.noReport,
    setting: config.report,
    cwd: io.cwd,
  });
  const humanOutput = report.enabled && report.out === "-" ? io.stderr : io.output;

  const impact = summarizeImpact(outcomes);
  writeImpactSummary(humanOutput, impact, dryRun);

  const durationMs = Date.now() - startedAtMs;
  const completion = summarizeRun(outcomes, durationMs);
  writeCompletion(humanOutput, completion);

  if (report.enabled) {
    const edits = orderEdits(outcomes.flatMap((outcome) => outcome.edits));
    const meta: RunMeta = {
      tool: "pocket-comb",
      version: VERSION,
      action: "suppress",
      configPath: config.configPath,
      configHash: config.configHash,
      target: config.targetRoot,
      startedAt,
      durationMs,
      dryRun,
      workers: result.workers,
      counts: {
        discovered: files.length,
        linted: outcomes.length,
        dropped: result.dropped.length,
        touched: outcomes.filter((outcome) => outcome.changed).length,
      },
    };
    emitReport({
      data: buildRunReport(meta, edits),
      format: report.format,
      out: report.out,
      stdout: io.output,
    });
  }

  // Exit 1 is the CI probe: a dry run with impact. An apply run writes and
  // exits 0; a zero-impact dry run exits 0 (spec §4).
  return dryRun && impact.edits > 0 ? 1 : 0;
}
