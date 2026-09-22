import { viewPolicy } from "./policy.js";
import { parseRegistry, recordMatchKey } from "./registry.js";
import type { ConfigSeverityLevel } from "./recognize.js";

export interface PolicyChangeInput {
  baselineConfig: string | null;
  headConfig: string | null;
  baselineRegistry: string | null;
  headRegistry: string | null;
  /** Rules governed under the baseline policy — used to judge allowlist narrowing. */
  baselineGoverned: string[];
  /** New or materially-changed governed debt introduced by the same change. */
  consumedDebt: number;
  /** Effective severity bands in the flat config, per tree (see `configSeverityLevels`). */
  baselineLevels: ConfigSeverityLevel[];
  headLevels: ConfigSeverityLevel[];
}

export type PolicyChangeSource = "protected" | "eslint-config" | "both" | "none";

export interface PolicyChangeResult {
  weakening: boolean;
  failure: boolean;
  /** Which surface weakened, for a truthful error message. */
  source: PolicyChangeSource;
}

/**
 * A malformed registry reads as broadened, so a broken head registry cannot
 * silently weaken enforcement (fail closed rather than fail open).
 */
const MALFORMED_REGISTRY = "<malformed>";

/**
 * The self-authorization rule: a weakening delta (to the protected
 * `.pocket-zipper` files or to the ESLint flat config's own rule severities)
 * that is consumed by new debt in the same change fails the gate. Pure:
 * callers supply the two documents from each tree.
 */
export function detectPolicyChange(input: PolicyChangeInput): PolicyChangeResult {
  const {
    baselineConfig,
    headConfig,
    baselineRegistry,
    headRegistry,
    baselineGoverned,
    consumedDebt,
    baselineLevels,
    headLevels,
  } = input;

  const protectedWeakened =
    configWeakened(baselineConfig, headConfig, baselineGoverned) ||
    registryBroadened(baselineRegistry, headRegistry);
  const eslintWeakened = configSeverityWeakened(baselineLevels, headLevels, baselineGoverned);

  const weakening = protectedWeakened || eslintWeakened;
  if (!weakening) return { weakening: false, failure: false, source: "none" };

  const source: PolicyChangeSource =
    protectedWeakened && eslintWeakened
      ? "both"
      : eslintWeakened
        ? "eslint-config"
        : "protected";
  return { weakening: true, failure: consumedDebt > 0, source };
}

function configWeakened(
  baselineRaw: string | null,
  headRaw: string | null,
  baselineGoverned: string[],
): boolean {
  const base = viewPolicy(baselineRaw);
  const head = viewPolicy(headRaw);
  // `enabled` flips true -> false, or is removed while the baseline declared it true.
  if (base.enabled && (!head.enabled || (base.enabledPresent && !head.enabledPresent))) {
    return true;
  }
  if (base.governedRules === null && head.governedRules !== null) {
    // Introducing an allowlist only weakens if it drops a rule the baseline
    // actually governed; a list covering every governed rule changes nothing.
    const headSet = new Set(head.governedRules);
    if (baselineGoverned.some((r) => !headSet.has(r))) return true;
  }
  if (base.governedRules !== null && head.governedRules !== null) {
    const headSet = new Set(head.governedRules);
    if (base.governedRules.some((r) => !headSet.has(r))) return true;
  }
  return false;
}

function registryBroadened(baselineRaw: string | null, headRaw: string | null): boolean {
  const keys = (raw: string | null): Set<string> => {
    if (raw === null || raw.trim() === "") return new Set();
    try {
      const records = parseRegistry(raw);
      return new Set(records.map((r) => recordMatchKey(r)));
    } catch {
      return new Set([MALFORMED_REGISTRY]);
    }
  };
  const base = keys(baselineRaw);
  const head = keys(headRaw);
  for (const k of head) if (!base.has(k)) return true;
  return false;
}

/**
 * A governed rule whose *effective* severity drops in the head's flat config is
 * a weakening of the governed surface — whether it falls off/warn/error, and
 * whether via a global or scoped declaration. Turning off a rule the allowlist
 * never governed changes nothing, so only baseline-governed rules count.
 *
 * Effective bands are compared per scope, with a global band standing in for
 * every scope that has no declaration of its own: "this rule is error here,
 * warn there, off everywhere the config does not mention it".
 */
function configSeverityWeakened(
  baselineLevels: ConfigSeverityLevel[],
  headLevels: ConfigSeverityLevel[],
  baselineGoverned: string[],
): boolean {
  const governed = new Set(baselineGoverned);
  const baselineByRule = new Map<string, ConfigSeverityLevel[]>();
  for (const l of baselineLevels) {
    const list = baselineByRule.get(l.rule);
    if (list) list.push(l);
    else baselineByRule.set(l.rule, [l]);
  }
  const headByRule = new Map<string, ConfigSeverityLevel[]>();
  for (const l of headLevels) {
    const list = headByRule.get(l.rule);
    if (list) list.push(l);
    else headByRule.set(l.rule, [l]);
  }

  const globalBand = (levels: ConfigSeverityLevel[]): number | undefined =>
    levels.find((l) => l.files === null)?.band;

  for (const rule of governed) {
    const base = baselineByRule.get(rule) ?? [];
    const head = headByRule.get(rule) ?? [];
    const baseGlobal = globalBand(base);
    const headGlobal = globalBand(head);

    // The global span: a rule's catch-all severity, and the fallback for any
    // scope without a declaration of its own on either side.
    if (baseGlobal !== undefined && headGlobal !== undefined && headGlobal < baseGlobal) {
      return true;
    }

    // Honed scopes: compare each scope name the two trees disagree about,
    // letting each side's global band speak for unnamed scopes.
    const scopes = new Set<string>();
    for (const l of base) scopes.add(spanKey(l));
    for (const l of head) scopes.add(spanKey(l));
    for (const key of scopes) {
      const baseBand = base.find((l) => spanKey(l) === key)?.band ?? baseGlobal;
      const headBand = head.find((l) => spanKey(l) === key)?.band ?? headGlobal;
      if (baseBand !== undefined && headBand !== undefined && headBand < baseBand) {
        return true;
      }
    }
  }
  return false;
}

function spanKey(level: ConfigSeverityLevel): string {
  return JSON.stringify({
    files: level.files ? [...level.files].map((s) => s.trim()).sort() : level.files,
    ignores: level.ignores ? [...level.ignores].map((s) => s.trim()).sort() : level.ignores,
  });
}
