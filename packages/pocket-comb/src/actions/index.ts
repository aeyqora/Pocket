import { NotImplementedError } from "../errors.js";
import { runSuppress } from "./suppress.js";
import { runFix } from "./fix.js";
import { runRemove } from "./remove.js";
import { runReplace } from "./replace.js";
import type { Action } from "../types.js";
import type { ActionContext, ActionHandler } from "./action.js";

/**
 * The verb -> command registry. This is the single dispatch seam: a later action
 * ticket adds its `actions/<verb>.ts` command and one entry here. A verb absent
 * from the map is intentionally not implemented yet.
 */
const HANDLERS: Partial<Record<Action, ActionHandler>> = {
  suppress: runSuppress,
  fix: runFix,
  remove: runRemove,
  replace: runReplace,
};

/**
 * Dispatch one validated verb. Returns the command's exit code (0 success, 1
 * dry-run impact); throws `NotImplementedError` — an operational error the CLI's
 * top-level handler maps to exit 2 — for a verb whose command has not landed.
 */
export async function runAction(action: Action, context: ActionContext): Promise<number> {
  const handler = HANDLERS[action];
  if (handler === undefined) {
    throw new NotImplementedError(`action '${action}' is not implemented yet`);
  }
  return handler(context);
}
