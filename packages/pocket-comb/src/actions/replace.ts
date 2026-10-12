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
import type { ReplaceParams } from "../engine.js";
import type { JsonValue } from "../types.js";

/**
 * The follow-on hint the replace report carries (spec §6.4): after a rename, the
 * renamed rules may suppress nothing at their new locations, so the next step is
 * a cleanup pass to prune directives that no longer guard anything. Carried only
 * when a rename actually happened.
 */
export const REPLACE_CLEANUP_HINT = "run cleanup to prune now-unused directives";

/**
 * `pocket-comb replace` — find-and-replace on rule tokens across every directive
 * (spec §6.4), end to end.
 *
 * Resolve the pair (`--from`/`--to` flags > `settings["pocket-comb"].replace`,
 * already merged by `loadConfig`), discover files, run the shared pipeline
 * through the worker pool (the owning workers write on `--apply`), then print the
 * impact summary, the cleanup hint when a rename happened, the completion
 * confirmation, and — unless `--no-report` — the post-run report (spec §13).
 *
 * Dry run is the non-interactive default: it prints what the run *would* change
 * and exits 1 when there is impact — the CI probe — 0 when there is none.
 */
export async function runReplace(context: ActionContext): Promise<number> {
  const { parsed, config, io } = context;
  const mode = parsed.mode ?? "dry-run";
  const dryRun = mode === "dry-run";
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  // `config.replace` already carries flag-over-settings precedence. A missing
  // pair is stopped before dispatch on a non-TTY run by the CLI's missing-flags
  // check; this branch is the interactive gap ticket 13's wizard fills.
  const pair = config.replace;
  if (pair === undefined) {
    throw new OperationalError(
      `replace needs a rule pair: pass --from <rule> --to <rule>, or set settings["pocket-comb"].replace`,
    );
  }

  const extensions = parsed.extensions ?? [...DEFAULT_EXTENSIONS];
  const { files } = await discover({ target: config.targetRoot, extensions });
  if (files.length === 0) {
    throw new OperationalError(`no files matched under ${config.targetRoot}`);
  }

  const params: ReplaceParams = { from: pair.from, to: pair.to };

  const spinner = createSpinner({ output: io.stderr, tty: io.tty });
  const result = await runPool({
    files,
    configPath: config.configPath,
    cwd: config.targetRoot,
    action: "replace",
    params: params as unknown as JsonValue,
    mode,
    ...(parsed.workers !== null ? { workers: parsed.workers } : {}),
    ...(parsed.batchSize !== null ? { batchSize: parsed.batchSize } : {}),
    serial: parsed.serial,
    onProgress: (progress) => spinner.update(progress),
  }).finally(() => spinner.stop());

  const outcomes = result.files;

  // Resolve the report before the human-facing output: when the report streams to
  // stdout (`--out -`), the impact/hint/completion lines move to stderr so the
  // piped report stays parseable (spec §13's piping shape).
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

  // Every replace ledger record is a rename, so impact > 0 means a rename
  // happened and the report carries the cleanup hint.
  const hint = impact.edits > 0 ? REPLACE_CLEANUP_HINT : undefined;
  if (hint !== undefined) humanOutput.write(`Next: ${hint}\n`);

  const durationMs = Date.now() - startedAtMs;
  const completion = summarizeRun(outcomes, durationMs);
  writeCompletion(humanOutput, completion);

  if (report.enabled) {
    const edits = orderEdits(outcomes.flatMap((outcome) => outcome.edits));
    const meta: RunMeta = {
      tool: "pocket-comb",
      version: VERSION,
      action: "replace",
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
      data: buildRunReport(meta, edits, hint),
      format: report.format,
      out: report.out,
      stdout: io.output,
    });
  }

  return dryRun && impact.edits > 0 ? 1 : 0;
}
