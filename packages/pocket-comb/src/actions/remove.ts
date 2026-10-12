import { relative } from "node:path";
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
import type { RemoveParams } from "../engine.js";
import type { JsonValue, NotActionableDirective } from "../types.js";

/**
 * `pocket-comb remove` — strip the config's rules from every suppression
 * directive (spec §6.3), end to end.
 *
 * Resolve the config/target, discover files, run the shared pipeline through the
 * worker pool (the owning workers write on `--apply`), then print the impact
 * summary, any bare directives that could not be actioned, the completion
 * confirmation, and — unless `--no-report` — the post-run report (spec §13).
 *
 * Dry run is the non-interactive default: it prints what the run *would* change
 * and exits 1 when there is impact — the CI probe — 0 when there is none.
 */
export async function runRemove(context: ActionContext): Promise<number> {
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

  const params: RemoveParams = { rules: config.rules };

  const spinner = createSpinner({ output: io.stderr, tty: io.tty });
  const result = await runPool({
    files,
    configPath: config.configPath,
    cwd: config.targetRoot,
    action: "remove",
    params: params as unknown as JsonValue,
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

  writeNotActionable(humanOutput, io.cwd, outcomes);

  const durationMs = Date.now() - startedAtMs;
  const completion = summarizeRun(outcomes, durationMs);
  writeCompletion(humanOutput, completion);

  if (report.enabled) {
    const edits = orderEdits(outcomes.flatMap((outcome) => outcome.edits));
    const meta: RunMeta = {
      tool: "pocket-comb",
      version: VERSION,
      action: "remove",
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

  return dryRun && impact.edits > 0 ? 1 : 0;
}

/**
 * List the bare directives remove could not scope (spec §6.3): a bare guard
 * names no rules, so stripping it would either guard everything (forbidden) or
 * change behaviour the config did not ask for. Stable order: file, then line.
 */
function writeNotActionable(
  output: NodeJS.WritableStream,
  cwd: string,
  outcomes: ReadonlyArray<{ notActionable?: NotActionableDirective[] }>,
): void {
  const notes = outcomes
    .flatMap((outcome) => outcome.notActionable ?? [])
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  if (notes.length === 0) return;

  output.write(`Not actionable: ${notes.length} bare directives (no rule list)\n`);
  for (const note of notes) {
    output.write(`  ${relative(cwd, note.file)}:${note.line} ${note.form} ${note.text}\n`);
  }
}
