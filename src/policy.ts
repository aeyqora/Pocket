import { parse as parseYaml } from "yaml";
import { configError } from "./errors.js";
import type { Policy } from "./types.js";

export const DEFAULT_POLICY: Policy = { enabled: true, governedRules: null };

/**
 * Tolerant, non-throwing view of a policy document. Shared by strict validation
 * (`parsePolicy`) and policy-change detection so the extraction lives once.
 */
export interface PolicyView {
  enabled: boolean;
  enabledPresent: boolean;
  enabledValid: boolean;
  governedRules: string[] | null;
  governedRulesValid: boolean;
  malformed: boolean;
}

export function viewPolicy(raw: string | null): PolicyView {
  const base: PolicyView = {
    enabled: true,
    enabledPresent: false,
    enabledValid: true,
    governedRules: null,
    governedRulesValid: true,
    malformed: false,
  };
  if (raw === null || raw.trim().length === 0) return base;
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    return { ...base, malformed: true };
  }
  if (doc === null || doc === undefined) return base;
  if (typeof doc !== "object" || Array.isArray(doc)) return { ...base, malformed: true };
  const obj = doc as Record<string, unknown>;

  const enabledRaw = obj["enabled"];
  const enabledPresent = enabledRaw !== undefined;
  const enabledValid = enabledRaw === undefined || typeof enabledRaw === "boolean";
  const enabled = typeof enabledRaw === "boolean" ? enabledRaw : true;

  const rulesRaw = obj["governedRules"];
  let governedRules: string[] | null = null;
  let governedRulesValid = true;
  if (rulesRaw !== undefined && rulesRaw !== null) {
    if (
      !Array.isArray(rulesRaw) ||
      rulesRaw.some((r) => typeof r !== "string" || r.trim().length === 0)
    ) {
      governedRulesValid = false;
    } else {
      governedRules = rulesRaw as string[];
    }
  }
  return { enabled, enabledPresent, enabledValid, governedRules, governedRulesValid, malformed: false };
}

export function parsePolicy(raw: string | null, knownRules: Set<string>): Policy {
  const view = viewPolicy(raw);
  if (view.malformed) throw configError("malformed .pocket-lock/config.yml");
  if (!view.enabledValid) {
    throw configError(".pocket-lock/config.yml: 'enabled' must be a boolean");
  }
  if (!view.enabled) {
    // Policy validation is skipped entirely when the gate is off.
    return { enabled: false, governedRules: null };
  }
  if (!view.governedRulesValid) {
    throw configError(
      ".pocket-lock/config.yml: 'governedRules' must be a list of non-empty strings",
    );
  }
  if (view.governedRules !== null && knownRules.size > 0) {
    for (const entry of view.governedRules) {
      if (!knownRules.has(entry)) {
        throw configError(
          `.pocket-lock/config.yml: governedRules names an unrecognized ESLint rule '${entry}'`,
        );
      }
    }
  }
  return { enabled: true, governedRules: view.governedRules };
}

export function computeGovernedSet(
  policy: Policy,
  applicable: Iterable<string>,
): string[] {
  const applicableSet = new Set(applicable);
  if (policy.governedRules === null) {
    return [...applicableSet].sort();
  }
  const out = policy.governedRules.filter((r) => applicableSet.has(r));
  out.sort();
  return out;
}
