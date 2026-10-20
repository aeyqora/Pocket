import { runActionPipeline } from "./runner.js";
import type { ActionContext } from "./action.js";

/**
 * `pocket-comb fix` — autofix the action config's rules under the isolated
 * instance (spec §6.2), through the shared action pipeline.
 *
 * Fixes come only from the config's rules by construction: the standalone
 * instance never reads the repo's own config. The owning workers write via
 * `ESLint.outputFixes`; a dry run reports the would-fix impact and never writes.
 * ESLint converges internally (the 10-pass cap with circular-fix detection), so
 * there is no repeat loop. The exit probe is files-touched, since a fix edits no
 * single rule line.
 */
export async function runFix(context: ActionContext): Promise<number> {
  return runActionPipeline(context, {
    action: "fix",
    params: {},
    hooks: {
      exitOnImpact: (impact) => impact.filesTouched > 0,
    },
  });
}
