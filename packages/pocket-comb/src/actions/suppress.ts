import { DEFAULT_EXTENSIONS, discover } from "../discovery.js";
import { OperationalError } from "../errors.js";
import { runPool } from "../pool.js";
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
 * worker pool (the owning workers write on `--apply`), then print the impact
 * summary and the completion confirmation. Dry run is the non-interactive
 * default: it prints what the run *would* change and exits 1 when there is
 * impact — the CI probe — 0 when there is none. Reports are ticket 07; this
 * command never emits one.
 */
export async function runSuppress(context: ActionContext): Promise<number> {
  const { parsed, config, io } = context;
  const mode = parsed.mode ?? "dry-run";
  const dryRun = mode === "dry-run";
  const startedAt = Date.now();

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
  const impact = summarizeImpact(outcomes);
  writeImpactSummary(io.output, impact, dryRun);

  const completion = summarizeRun(outcomes, Date.now() - startedAt);
  writeCompletion(io.output, completion);

  // Exit 1 is the CI probe: a dry run with impact. An apply run writes and
  // exits 0; a zero-impact dry run exits 0 (spec §4).
  return dryRun && impact.edits > 0 ? 1 : 0;
}
