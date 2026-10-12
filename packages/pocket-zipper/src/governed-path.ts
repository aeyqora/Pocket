import { patternMatches } from "./path-pattern.js";
import type { LogicalSuppression, Policy } from "./types.js";

/**
 * The governed-path set and the per-suppression judgment built on it.
 *
 * Governed = (governedPaths ?? every tracked path) − ungovernedPaths, exclusion
 * winning. The two keys are orthogonal to the rule axis: a suppression counts
 * only when both its rule and its path are governed. Directive suppressions are
 * judged by their file's path; config-offs are judged by their ESLint config
 * block's declared reach (`files`/`ignores`), never the config file's own path —
 * flat configs live at the repository root, so judging by the file's path would
 * ungovern every config-off the moment an allowlist named a package directory.
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
 * The governed path set: the tracked paths the policy governs, as a set. The
 * reach judgment and the policy track both intersect against this, so it is
 * computed once and passed around rather than re-derived at each call site.
 */
export function governedPathSet(
  policy: Policy,
  pathInventory: ReadonlySet<string>,
): Set<string> {
  return new Set([...pathInventory].filter((path) => isGovernedPath(policy, path)));
}

/**
 * Whether a config block's declared reach intersects the governed set. An
 * unscoped block (`files === null`) reaches everything and is always governed;
 * a scoped block is governed only when some governed path matches its `files`
 * and none of its `ignores`.
 */
export function scopeReachesGoverned(
  files: readonly string[] | null,
  ignores: readonly string[] | null,
  governedPaths: ReadonlySet<string>,
): boolean {
  if (files === null) return true;
  return [...governedPaths].some(
    (path) =>
      files.some((pattern) => patternMatches(pattern, path)) &&
      !(ignores ?? []).some((pattern) => patternMatches(pattern, path)),
  );
}

/**
 * Whether a logical suppression is governed, on the path axis. A directive is
 * governed by the path it sits in; a config-off is governed by its config
 * block's declared reach intersecting the governed set.
 */
export function isGovernedSuppression(
  policy: Policy,
  suppression: LogicalSuppression,
  governedPaths: ReadonlySet<string>,
): boolean {
  if (suppression.guardKind === "config-level") {
    return scopeReachesGoverned(suppression.files ?? null, suppression.ignores ?? null, governedPaths);
  }
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
