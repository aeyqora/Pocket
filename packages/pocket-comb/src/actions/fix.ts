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

/**
 * `pocket-comb fix` — autofix the action config's rules under the isolated
 * instance (spec §6.2), end to end.
 *
 * Fixes come only from the config's rules by construction: the standalone
 * instance never reads the repo's own config. The owning workers write via
 * `ESLint.outputFixes`; a dry run reports the would-fix impact and never writes.
 * ESLint converges internally (the 10-pass cap with circular-fix detection), so
 * there is no repeat loop here. Unless `--no-report`, the run emits the
 * post-run report (spec §13).
 */
export async function runFix(context: ActionContext): Promise<number> {
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

  const spinner = createSpinner({ output: io.stderr, tty: io.tty });
  const result = await runPool({
    files,
    configPath: config.configPath,
    cwd: config.targetRoot,
    action: "fix",
    params: {},
    mode,
    ...(parsed.workers !== null ? { workers: parsed.workers } : {}),
    ...(parsed.batchSize !== null ? { batchSize: parsed.batchSize } : {}),
    serial: parsed.serial,
    onProgress: (progress) => spinner.update(progress),
  }).finally(() => spinner.stop());

  const outcomes = result.files;

  // Resolve the report before the human-facing output: when the report streams to
  // stdout (`--out -`), the impact/completion lines move to stderr so the piped
  // report stays parseable (spec §13's piping shape).
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
      action: "fix",
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

  return dryRun && impact.filesTouched > 0 ? 1 : 0;
}
