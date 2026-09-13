import { parse as parseYaml } from "yaml";
import { configError } from "./errors.js";
import type { Policy } from "./types.js";

export const DEFAULT_POLICY: Policy = { enabled: true, governedRules: null };

export function parsePolicy(raw: string | null, knownRules: Set<string>): Policy {
  if (raw === null || raw.trim().length === 0) return { ...DEFAULT_POLICY };
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw configError("malformed .pocket-lock/config.yml", String(err));
  }
  if (doc === null || doc === undefined) return { ...DEFAULT_POLICY };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw configError(".pocket-lock/config.yml must be a mapping");
  }
  const obj = doc as Record<string, unknown>;
  const enabledRaw = obj["enabled"];
  let enabled = true;
  if (enabledRaw !== undefined) {
    if (typeof enabledRaw !== "boolean") {
      throw configError(".pocket-lock/config.yml: 'enabled' must be a boolean");
    }
    enabled = enabledRaw;
  }
  if (!enabled) {
    // Policy validation is skipped entirely when the gate is off.
    return { enabled: false, governedRules: null };
  }
  const governedRaw = obj["governedRules"];
  let governedRules: string[] | null = null;
  if (governedRaw !== undefined && governedRaw !== null) {
    if (!Array.isArray(governedRaw)) {
      throw configError(".pocket-lock/config.yml: 'governedRules' must be a list");
    }
    governedRules = [];
    for (const entry of governedRaw) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw configError(
          ".pocket-lock/config.yml: 'governedRules' entries must be non-empty strings",
        );
      }
      // Plugin-scoped rules (e.g. `jsx-a11y/no-autofocus`) cannot be verified
      // against ESLint's built-in rule set without loading the plugin, so they
      // are accepted; core rules are checked against the built-in set.
      if (knownRules.size > 0 && !entry.includes("/") && !knownRules.has(entry)) {
        throw configError(
          `.pocket-lock/config.yml: governedRules names an unrecognized ESLint rule '${entry}'`,
        );
      }
      governedRules.push(entry);
    }
  }
  return { enabled, governedRules };
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
