import { OperationalError } from "../errors.js";
import { runActionPipeline } from "./runner.js";
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
 * (spec §6.4), through the shared action pipeline.
 *
 * The pair (`--from`/`--to` flags > `settings["pocket-comb"].replace`) is already
 * merged by `loadConfig`. A missing pair is stopped before dispatch on a non-TTY
 * run by the CLI's missing-flags check; the check below is the interactive gap
 * ticket 13's wizard fills. Every replace ledger record is a rename, so impact
 * > 0 means the cleanup hint is due.
 */
export async function runReplace(context: ActionContext): Promise<number> {
  const pair = context.config.replace;
  if (pair === undefined) {
    throw new OperationalError(
      `replace needs a rule pair: pass --from <rule> --to <rule>, or set settings["pocket-comb"].replace`,
    );
  }

  const params: ReplaceParams = { from: pair.from, to: pair.to };

  return runActionPipeline(context, {
    action: "replace",
    params: params as unknown as JsonValue,
    hooks: {
      hint: (impact) => (impact.edits > 0 ? REPLACE_CLEANUP_HINT : undefined),
      afterImpact: (output, _outcomes, hint) => {
        if (hint !== undefined) output.write(`Next: ${hint}\n`);
      },
    },
  });
}
