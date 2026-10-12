import { writeNotActionable } from "../ui.js";
import { runActionPipeline } from "./runner.js";
import type { ActionContext } from "./action.js";
import type { SuppressParams } from "../engine.js";
import type { JsonValue } from "../types.js";

/**
 * `pocket-comb suppress` — the flagship command (spec §6.1), wired to the shared
 * action pipeline.
 *
 * The suppress strategy's params (spec §6.1): `reuseBlocks` is read by the
 * engine; `fixFirst` is a pool-level phase (fix → re-lint → suppress) and is
 * passed through as `fixFirst`. Bare guards the plan could not rewrite are
 * surfaced as not-actionable notes (step 3: skip + report).
 *
 * Dry run is the non-interactive default: it prints what the run *would* change
 * and exits 1 when there is impact — the CI probe — 0 when there is none.
 */
export async function runSuppress(context: ActionContext): Promise<number> {
  const { parsed } = context;

  const params: SuppressParams = {};
  if (parsed.reason !== null) params.reason = parsed.reason;
  if (parsed.reuseBlocks) params.reuseBlocks = true;
  if (parsed.fixFirst) params.fixFirst = true;

  return runActionPipeline(context, {
    action: "suppress",
    params: params as unknown as JsonValue,
    ...(parsed.fixFirst ? { fixFirst: true } : {}),
    hooks: {
      afterImpact: (output, outcomes) => writeNotActionable(output, context.io.cwd, outcomes),
    },
  });
}
