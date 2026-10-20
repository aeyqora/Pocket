import { writeNotActionable } from "../ui.js";
import { runActionPipeline } from "./runner.js";
import type { ActionContext } from "./action.js";
import type { CleanupParams } from "../engine.js";
import type { JsonValue } from "../types.js";

/**
 * `pocket-comb cleanup` — prune unused suppression directives (spec §6.5),
 * through the shared action pipeline.
 *
 * Bare directives whose unused-ness could not be scoped are listed after the
 * impact summary. Dry run is the non-interactive default: it prints what the run
 * *would* change and exits 1 when there is impact — the CI probe — 0 when there
 * is none.
 */
export async function runCleanup(context: ActionContext): Promise<number> {
  const params: CleanupParams = { rules: context.config.rules };

  return runActionPipeline(context, {
    action: "cleanup",
    params: params as unknown as JsonValue,
    hooks: {
      afterImpact: (output, outcomes) => writeNotActionable(output, context.io.cwd, outcomes),
    },
  });
}
