import { writeNotActionable } from "../ui.js";
import { runActionPipeline } from "./runner.js";
import type { ActionContext } from "./action.js";
import type { RemoveParams } from "../engine.js";
import type { JsonValue } from "../types.js";

/**
 * `pocket-comb remove` — strip the config's rules from every suppression
 * directive (spec §6.3), through the shared action pipeline.
 *
 * Bare directives that could not be scoped are listed after the impact summary.
 * Dry run is the non-interactive default: it prints what the run *would* change
 * and exits 1 when there is impact — the CI probe — 0 when there is none.
 */
export async function runRemove(context: ActionContext): Promise<number> {
  const params: RemoveParams = { rules: context.config.rules };

  return runActionPipeline(context, {
    action: "remove",
    params: params as unknown as JsonValue,
    hooks: {
      afterImpact: (output, outcomes) => writeNotActionable(output, context.io.cwd, outcomes),
    },
  });
}
