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

/**
 * `pocket-comb fix` — autofix the action config's rules under the isolated
 * instance (spec §6.2).
 *
 * Fixes come only from the config's rules by construction: the standalone
 * instance never reads the repo's own config. The owning workers write via
 * `ESLint.outputFixes`; a dry run reports the would-fix impact and never
 * writes. ESLint converges internally (the 10-pass cap with circular-fix
 * detection), so there is no repeat loop here.
 */
export async function runFix(context: ActionContext): Promise<number> {
  const { parsed, config, io } = context;
  const mode = parsed.mode ?? "dry-run";
  const dryRun = mode === "dry-run";
  const startedAt = Date.now();

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
  const impact = summarizeImpact(outcomes);
  writeImpactSummary(io.output, impact, dryRun);

  const completion = summarizeRun(outcomes, Date.now() - startedAt);
  writeCompletion(io.output, completion);

  return dryRun && impact.filesTouched > 0 ? 1 : 0;
}
