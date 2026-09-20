import { driftDisposition, matchKey, pairPools, type LineDiff } from "./identity.js";
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
}

export interface ReconcileOutput {
  head: ReconciledSuppression[];
  removed: LogicalSuppression[];
}

/**
 * Continuity is by fingerprint (§8.2): form + normalized rule tokens. Pools
 * additionally separate by guarded rule and suppression type so multi-rule
 * directives expand independently.
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const { headSuppressions, baselineSuppressions, lineDiffs, baselineIndex, headIndex } =
    input;

  const groups = new Map<string, { head: LogicalSuppression[]; baseline: LogicalSuppression[] }>();
  for (const s of baselineSuppressions) {
    const k = matchKey(s);
    const g = groups.get(k) ?? { head: [], baseline: [] };
    g.baseline.push(s);
    groups.set(k, g);
  }
  for (const s of headSuppressions) {
    const k = matchKey(s);
    const g = groups.get(k) ?? { head: [], baseline: [] };
    g.head.push(s);
    groups.set(k, g);
  }

  const headOut: ReconciledSuppression[] = [];
  const removedOut: LogicalSuppression[] = [];
  const matchedBaseline = new Set<LogicalSuppression>();

  for (const [, group] of groups) {
    const pairs = pairPools(group.head, group.baseline);
    const pairedHead = new Set<LogicalSuppression>();
    for (const p of pairs) {
      pairedHead.add(p.head);
      matchedBaseline.add(p.baseline);
      let disposition: Disposition = driftDisposition(p.head, p.baseline);
      if (isTomb(p.head, p.baseline, lineDiffs, baselineIndex, headIndex)) {
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
 * A head directive H text-matched to baseline twin B is materially-changed
 * (the tomb) when H's comment is newborn, B's guarded statement is diff-removed,
 * and neither guarded statement survives in the other tree.
 */
function isTomb(
  head: LogicalSuppression,
  baseline: LogicalSuppression,
  lineDiffs: Map<string, LineDiff>,
  baselineIndex: Set<string>,
  headIndex: Set<string>,
): boolean {
  if (head.guardKind !== "directive") return false;
  if (head.suppressionType !== "next-line" && head.suppressionType !== "line") return false;

  // Newborn: the comment is diff-added, or its guarded statement moved to a new
  // position. A guarded statement rewritten at the same position is an in-place
  // rewrite (existing debt), never a tomb.
  const guardMoved = head.guardStart !== baseline.guardStart;
  if (!commentIsNewborn(head, lineDiffs) && !guardMoved) return false;

  // Spec §8.3 condition 3: the twin's *guarded* line is diff-removed (for a
  // `line` directive that coincides with the comment line).
  if (!twinStatementIsRemoved(head, baseline, lineDiffs)) return false;

  const newStatement =
    head.guardedContent.length > 0 && !baselineIndex.has(head.guardedContent);
  const deadTwin =
    baseline.guardedContent.length > 0 && !headIndex.has(baseline.guardedContent);
  return newStatement && deadTwin;
}

/** `diffLineIndices` is 0-based; the domain carries 1-based lines. */
function commentIsNewborn(
  head: LogicalSuppression,
  lineDiffs: Map<string, LineDiff>,
): boolean {
  const diff = lineDiffs.get(head.file);
  return diff ? diff.addedHead.has(head.line - 1) : false;
}

/** The diff is keyed by the head path; `baseline.guardStart` indexes into it. */
function twinStatementIsRemoved(
  head: LogicalSuppression,
  baseline: LogicalSuppression,
  lineDiffs: Map<string, LineDiff>,
): boolean {
  const diff = lineDiffs.get(head.file);
  return diff ? diff.removedBase.has(baseline.guardStart - 1) : false;
}

function compareSuppressions(a: LogicalSuppression, b: LogicalSuppression): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule);
}
