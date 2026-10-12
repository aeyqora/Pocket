import { composeRule } from "./compose.js";
import { TAILORING, type TailoredRuleModule, type TailoringDefinition } from "./types.js";

/**
 * Declare a tailored rule.
 *
 * - When `tailors` is a direct rule module, the result is a fully runnable
 *   composed rule (`meta` + `create`), usable with `RuleTester` and no harness.
 * - When `tailors` is a name, the result is a declaration carrying the name,
 *   `meta`, `report`, and `autofix`; `tailor()` composes it once the upstream
 *   rule is resolved. Invoking its `create()` before then throws.
 *
 * The tailoring definition is exposed on the module under {@link TAILORING}.
 */
export function defineTailoredRule(definition: TailoringDefinition): TailoredRuleModule {
  if (typeof definition.tailors !== "string") {
    return composeRule(definition.tailors, definition);
  }

  const name = definition.tailors;
  return {
    // The upstream meta is unknown until resolution, so carry only what the
    // author declared. `schema: false` keeps option validation out of the way so
    // the unresolved error below is the one that surfaces.
    meta: {
      ...(definition.meta ?? {}),
      schema: false,
    },
    create() {
      throw new Error(
        `pocket-tailor: tailored rule '${name}' has not been resolved. ` +
          `It references its upstream rule by name, so it must be composed by tailor() ` +
          `(which resolves '${name}' from the wrapped plugin) before it can run. ` +
          `To run it standalone, pass the upstream rule module directly as 'tailors'.`,
      );
    },
    [TAILORING]: definition,
  };
}
