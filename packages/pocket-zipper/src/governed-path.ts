import { patternMatches } from "./path-pattern.js";
import type { LogicalSuppression, Policy } from "./types.js";

/**
 * The governed-path set and the per-suppression judgment built on it.
 *
 * Governed = (governedPaths ?? every tracked path) − ungovernedPaths, exclusion
 * winning. The two keys are orthogonal to the rule axis: a suppression counts
 * only when both its rule and its path are governed. Directive suppressions are
 * judged by their file's path; config-offs are not — their scope is their ESLint
 * config block's declared reach, never the config file's own path (flat configs
 * live at the repository root, so judging by the file's path would ungovern
 * every config-off the moment an allowlist named a package directory).
 */

/**
 * Whether a repository-relative path is inside the governed set: claimed by the
 * allowlist (or the default of everything) and not subtracted.
 */
export function isGovernedPath(policy: Policy, path: string): boolean {
  const allowed =
    policy.governedPaths === null ||
    policy.governedPaths.some((pattern) => patternMatches(pattern, path));
  const excluded =
    policy.ungovernedPaths !== null &&
    policy.ungovernedPaths.some((pattern) => patternMatches(pattern, path));
  return allowed && !excluded;
}

/**
 * Whether a logical suppression is governed, on the path axis. A directive is
 * governed by the path it sits in; a config-off is always governed here — its
 * reach scoping is the policy track's own concern and lives in `policy-change`,
 * not in inventory filtering.
 */
export function isGovernedSuppression(
  policy: Policy,
  suppression: LogicalSuppression,
): boolean {
  if (suppression.guardKind === "config-level") return true;
  return isGovernedPath(policy, suppression.file);
}

/** The parsed, sorted governed-path list, or null when the key is absent. */
export function sortedGovernedPaths(policy: Policy): string[] | null {
  return policy.governedPaths === null ? null : [...policy.governedPaths].sort();
}

/** The parsed, sorted subtractor list, or null when the key is absent. */
export function sortedUngovernedPaths(policy: Policy): string[] | null {
  return policy.ungovernedPaths === null ? null : [...policy.ungovernedPaths].sort();
}
