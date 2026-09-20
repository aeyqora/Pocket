import { viewPolicy } from "./policy.js";
import { parseRegistry, recordMatchKey } from "./registry.js";

export interface PolicyChangeInput {
  baselineConfig: string | null;
  headConfig: string | null;
  baselineRegistry: string | null;
  headRegistry: string | null;
  /** Rules governed under the baseline policy — used to judge allowlist narrowing. */
  baselineGoverned: string[];
  /** New or materially-changed governed debt introduced by the same change. */
  consumedDebt: number;
}

export interface PolicyChangeResult {
  weakening: boolean;
  failure: boolean;
}

/**
 * A malformed registry reads as broadened, so a broken head registry cannot
 * silently weaken enforcement (fail closed rather than fail open).
 */
const MALFORMED_REGISTRY = "<malformed>";

/**
 * The self-authorization rule: a protected-file weakening delta that is
 * consumed by new debt in the same change fails the gate. Pure: callers
 * supply the two documents from each tree.
 */
export function detectPolicyChange(input: PolicyChangeInput): PolicyChangeResult {
  const {
    baselineConfig,
    headConfig,
    baselineRegistry,
    headRegistry,
    baselineGoverned,
    consumedDebt,
  } = input;

  const weakening =
    configWeakened(baselineConfig, headConfig, baselineGoverned) ||
    registryBroadened(baselineRegistry, headRegistry);

  if (!weakening) return { weakening: false, failure: false };
  return { weakening: true, failure: consumedDebt > 0 };
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
