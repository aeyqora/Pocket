import { normalizeWhitespace, parseDirectiveArgs } from "./identity.js";
import type { Disposition, LogicalSuppression } from "./types.js";

/**
 * The continuity matcher: given two suppressions with the same canonical
 * identity, deciding whether they are the *same* suppression across two trees.
 *
 * This is where **suppression continuity** is decided: whether two logical
 * suppressions in different trees are the same suppression. Identity — form plus
 * normalized rule tokens, hashed into a fingerprint — is `identity.ts`;
 * what this module adds is the judgment that two things carrying one identity
 * are one suppression, and that the code beneath a directive is never part of it.
 *
 * Two things are deliberately *not* the same as a **Pool**. A pool is where
 * records compete for suppressions; a match key here groups suppressions for the
 * matcher, and nothing is allocated. The name `pairPools` was retired because it
 * borrowed a term the domain already defines elsewhere.
 */

/**
 * Canonical text for the whole-tree content index: whitespace-normalized, with
 * a directive's justification stripped. `--` separates justification only on
 * an eslint directive, so code such as `a -- b` is left intact.
 */
export function canonicalCodeLine(line: string): string {
  let s = normalizeWhitespace(line);
  const m = /\s--\s+/.exec(s);
  if (m && /eslint-/.test(s.slice(0, m.index))) s = s.slice(0, m.index);
  return s;
}

/**
 * Canonical text for change-movement comparison. A `line`-form directive shares
 * its physical line with the guarded statement, so the code must be stripped:
 * identity is the directive comment, and rewriting the code beside it must not
 * read as a newly introduced comment.
 */
export function canonicalMovementLine(line: string): string {
  const directive = /(?:\/\/|\/\*)\s*eslint-disable-(next-line|line)\b([\s\S]*)$/.exec(line);
  if (!directive) return canonicalCodeLine(line);
  const { rules } = parseDirectiveArgs((directive[2] ?? "").replace(/\s*\*\/\s*$/, ""));
  return `eslint-disable-${directive[1]} ${rules.join(",")}`;
}

function tokenize(text: string): string[] {
  return normalizeWhitespace(text).match(/[A-Za-z0-9_$]+/g) ?? [];
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 1 : inter / union;
}

export interface LineDiff {
  addedHead: Set<number>;
  removedBase: Set<number>;
}

/**
 * LCS line diff with a caller-supplied equality predicate. Indices are 0-based.
 */
export function diffLineIndices(
  base: string[],
  head: string[],
  eq: (a: string, b: string) => boolean = (a, b) => a === b,
): LineDiff {
  const n = base.length;
  const m = head.length;
  const dp: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = eq(base[i]!, head[j]!)
        ? dp[i +  1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const addedHead = new Set<number>();
  const removedBase = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(base[i]!, head[j]!)) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      removedBase.add(i);
      i++;
    } else {
      addedHead.add(j);
      j++;
    }
  }
  while (i < n) {
    removedBase.add(i);
    i++;
  }
  while (j < m) {
    addedHead.add(j);
    j++;
  }
  return { addedHead, removedBase };
}

export interface SuppressionPair {
  head: LogicalSuppression;
  baseline: LogicalSuppression;
  similarity: number;
}

/**
 * Pair the head and baseline suppressions sharing one match key, highest
 * guard-context similarity first. Never by line number; ties fall back to
 * file, head index, and baseline index for a total order.
 */
export function pairBySimilarity(
  headGroup: LogicalSuppression[],
  baselineGroup: LogicalSuppression[],
  isCompatible: (head: LogicalSuppression, baseline: LogicalSuppression) => boolean = () =>
    true,
): SuppressionPair[] {
  const candidates: Array<{ h: number; b: number; sim: number }> = [];
  for (let hi = 0; hi < headGroup.length; hi++) {
    const ht = tokenize(headGroup[hi]!.guardedContent);
    for (let bi = 0; bi < baselineGroup.length; bi++) {
      if (!isCompatible(headGroup[hi]!, baselineGroup[bi]!)) continue;
      const sim = jaccard(ht, tokenize(baselineGroup[bi]!.guardedContent));
      candidates.push({ h: hi, b: bi, sim });
    }
  }
  candidates.sort(
    (x, y) =>
      y.sim - x.sim ||
      headGroup[x.h]!.file.localeCompare(headGroup[y.h]!.file) ||
      x.h - y.h ||
      x.b - y.b,
  );
  const usedH = new Set<number>();
  const usedB = new Set<number>();
  const pairs: SuppressionPair[] = [];
  for (const c of candidates) {
    if (usedH.has(c.h) || usedB.has(c.b)) continue;
    usedH.add(c.h);
    usedB.add(c.b);
    pairs.push({ head: headGroup[c.h]!, baseline: baselineGroup[c.b]!, similarity: c.sim });
  }
  return pairs;
}

export function driftDisposition(
  head: LogicalSuppression,
  baseline: LogicalSuppression,
): Extract<Disposition, "existing" | "moved-existing"> {
  if (head.file === baseline.file && head.line === baseline.line) return "existing";
  return "moved-existing";
}
