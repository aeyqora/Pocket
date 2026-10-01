import { driftDisposition, pairBySimilarity, type LineDiff } from "./continuity.js";
import { matchKey } from "./identity.js";
import type {
  Disposition,
  LogicalSuppression,
  ReconciledSuppression,
} from "./types.js";

export interface ReconcileInput {
  headSuppressions: LogicalSuppression[];
  baselineSuppressions: LogicalSuppression[];
  lineDiffs: Map<string, LineDiff>;
  baselineIndex: Set<string>;
  headIndex: Set<string>;
  /** post-image path -> pre-image path for git-recognized renames */
  renames?: ReadonlyMap<string, string>;
}

export interface ReconcileOutput {
  head: ReconciledSuppression[];
  removed: LogicalSuppression[];
}

/**
 * Continuity is by fingerprint: form + normalized rule tokens. Pools
 * additionally separate by guarded rule and suppression type so multi-rule
 * directives expand independently.
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const {
    headSuppressions,
    baselineSuppressions,
    lineDiffs,
    baselineIndex,
    headIndex,
    renames = new Map(),
  } = input;

  // Grouped by match key, so a directive that moved or was rewritten still
  // meets its counterpart. This is not a **Pool** (a pool is where records
  // compete for suppressions): nothing is allocated here, and the matcher
  // consumes these groups directly.
  const byMatchKey = new Map<string, { head: LogicalSuppression[]; baseline: LogicalSuppression[] }>();
  for (const s of baselineSuppressions) {
    const k = matchKey(s);
    const g = byMatchKey.get(k) ?? { head: [], baseline: [] };
    g.baseline.push(s);
    byMatchKey.set(k, g);
  }
  for (const s of headSuppressions) {
    const k = matchKey(s);
    const g = byMatchKey.get(k) ?? { head: [], baseline: [] };
    g.head.push(s);
    byMatchKey.set(k, g);
  }

  const headOut: ReconciledSuppression[] = [];
  const removedOut: LogicalSuppression[] = [];
  const matchedBaseline = new Set<LogicalSuppression>();

  for (const [, group] of byMatchKey) {
    const pairs = pairBySimilarity(
      group.head,
      group.baseline,
      (head, baseline) =>
        head.file === baseline.file || renames.get(head.file) === baseline.file,
    );
    const pairedHead = new Set<LogicalSuppression>();
    for (const p of pairs) {
      pairedHead.add(p.head);
      matchedBaseline.add(p.baseline);
      let disposition: Disposition = driftDisposition(p.head, p.baseline);
      // Line diffs are keyed by post-image path. For a rename, that diff's
      // baseline side is the renamed-from path, so it is the pair's only valid
      // coordinate space for both lines.
      if (isTomb(p.head, p.baseline, lineDiffs.get(p.head.file), baselineIndex, headIndex)) {
        disposition = "materially-changed";
      }
      headOut.push({
        ...p.head,
        disposition,
        baselineLine: p.baseline.line,
        exception: null,
      });
    }
    for (const h of group.head) {
      if (pairedHead.has(h)) continue;
      headOut.push({ ...h, disposition: "new", baselineLine: null, exception: null });
    }
    for (const b of group.baseline) {
      if (!matchedBaseline.has(b)) removedOut.push(b);
    }
  }

  headOut.sort(compareSuppressions);
  removedOut.sort(compareSuppressions);
  return { head: headOut, removed: removedOut };
}

/**
 * The disposition half of **new debt**, on its own: a suppression with no
 * continuous baseline counterpart, or a materially-changed one. Stated apart
 * from exceptability, which is a property of **Suppression type** and lives in
 * `exception-match`, because the two are different questions — a new `config-off`
 * answers this one and fails the other.
 *
 * Disposition-only on purpose: the head partitions cleanly by it. Every
 * suppression is unpaired, exceptable, or both, and no suppression is neither.
 */
export function isUnpaired(suppression: { readonly disposition: Disposition }): boolean {
  return (
    suppression.disposition === "new" || suppression.disposition === "materially-changed"
  );
}

/**
 * A head directive H text-matched to baseline twin B is materially-changed
 * (the tomb) when H's comment is newborn, B's guarded statement is diff-removed,
 * and neither guarded statement survives in the other tree.
 */
function isTomb(
  head: LogicalSuppression,
  baseline: LogicalSuppression,
  lineDiff: LineDiff | undefined,
  baselineIndex: Set<string>,
  headIndex: Set<string>,
): boolean {
  if (head.guardKind !== "directive") return false;
  if (head.suppressionType !== "next-line" && head.suppressionType !== "line") return false;

  // Newborn: the comment is diff-added, or its guarded statement moved to a new
  // position. A guarded statement rewritten at the same position is an in-place
  // rewrite (existing debt), never a tomb.
  const guardMoved = head.guardStart !== baseline.guardStart;
  if (!commentIsNewborn(head, lineDiff) && !guardMoved) return false;

  // Tomb condition: the twin's *guarded* line is diff-removed (for a
  // `line` directive that coincides with the comment line).
  if (!twinStatementIsRemoved(baseline, lineDiff)) return false;

  const newStatement =
    head.guardedContent.length > 0 && !baselineIndex.has(head.guardedContent);
  const deadTwin =
    baseline.guardedContent.length > 0 && !headIndex.has(baseline.guardedContent);
  return newStatement && deadTwin;
}

/** `diffLineIndices` is 0-based; the domain carries 1-based lines. */
function commentIsNewborn(
  head: LogicalSuppression,
  lineDiff: LineDiff | undefined,
): boolean {
  return lineDiff ? lineDiff.addedHead.has(head.line - 1) : false;
}

/** `lineDiff` belongs to the pair's head path; the baseline line indexes its base side. */
function twinStatementIsRemoved(
  baseline: LogicalSuppression,
  lineDiff: LineDiff | undefined,
): boolean {
  return lineDiff ? lineDiff.removedBase.has(baseline.guardStart - 1) : false;
}

function compareSuppressions(a: LogicalSuppression, b: LogicalSuppression): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule);
}
