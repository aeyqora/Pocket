import { createHash } from "node:crypto";
import type { Disposition, LogicalSuppression, SuppressionType } from "./types.js";

export const FINGERPRINT_PREFIX = "v1:sha256:";

export function normalizeRuleTokens(tokens: string[]): string[] {
  const set = new Set<string>();
  for (const t of tokens) {
    const v = t.trim();
    if (v.length > 0) set.add(v);
  }
  const out = [...set];
  out.sort();
  return out;
}

export function canonicalDirectiveText(
  form: Exclude<SuppressionType, "config-off">,
  ruleTokens: string[],
): string {
  return `${form}\n${normalizeRuleTokens(ruleTokens).join(",")}`;
}

/**
 * Split a directive's argument text into normalized rule tokens and its
 * free-text justification. One parser feeds recognition and movement
 * canonicalization alike.
 */
export function parseDirectiveArgs(raw: string): {
  rules: string[];
  justification: string;
} {
  let body = raw.trim();
  let justification = "";
  const m = /\s--\s+([\s\S]*)$/.exec(body);
  if (m) {
    justification = m[1]!.trim();
    body = body.slice(0, m.index).trim();
  }
  const rules = body.split(/[\s,]+/).filter(Boolean);
  return { rules: normalizeRuleTokens(rules), justification };
}

export function canonicalConfigOffText(rule: string, scopeKey: string): string {
  return `config-off\n${rule}\n${scopeKey}`;
}

/**
 * The suppression's match key: fingerprint + suppression type + rule, never
 * position. One spelling shared by pool grouping, exception matching, and
 * registry-broadening detection.
 */
export function matchKey(key: {
  fingerprint: string;
  suppressionType: SuppressionType;
  rule: string;
}): string {
  return `${key.fingerprint}\u0000${key.suppressionType}\u0000${key.rule}`;
}

export function normalizedPatterns(
  patterns: string[] | null | undefined,
): string[] | null {
  return patterns ? [...patterns].map((s) => s.trim()).sort() : null;
}

export function scopeKeyOf(
  configFile: string,
  files: string[] | null,
  ignores: string[] | null,
): string {
  return JSON.stringify({
    config: configFile,
    files: normalizedPatterns(files),
    ignores: normalizedPatterns(ignores),
  });
}

export function fingerprintOf(canonicalText: string): string {
  const hex = createHash("sha256").update(canonicalText, "utf8").digest("hex");
  return `${FINGERPRINT_PREFIX}${hex}`;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

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
 * Canonical text for change-movement comparison. A `line`-form directive
 * shares its physical line with the guarded statement, so the code must be
 * stripped: identity is the directive comment, and rewriting the code beside
 * it must not read as a newly introduced comment.
 */
export function canonicalMovementLine(line: string): string {
  const directive = /(?:\/\/|\/\*)\s*eslint-disable-(next-line|line)\b([\s\S]*)$/.exec(line);
  if (!directive) return canonicalCodeLine(line);
  const { rules } = parseDirectiveArgs((directive[2] ?? "").replace(/\s*\*\/\s*$/, ""));
  return `eslint-disable-${directive[1]} ${rules.join(",")}`;
}

export function tokenize(text: string): string[] {
  return normalizeWhitespace(text).match(/[A-Za-z0-9_$]+/g) ?? [];
}

export function jaccard(a: string[], b: string[]): number {
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
        ? dp[i + 1]![j + 1]! + 1
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
 * Greedy pool allocation by guard-context similarity (highest first). Never by
 * line number; ties fall back to stable pool order for determinism only.
 */
export function pairPools(
  headPool: LogicalSuppression[],
  baselinePool: LogicalSuppression[],
): SuppressionPair[] {
  const candidates: Array<{ h: number; b: number; sim: number }> = [];
  for (let hi = 0; hi < headPool.length; hi++) {
    const ht = tokenize(headPool[hi]!.guardedContent);
    for (let bi = 0; bi < baselinePool.length; bi++) {
      const sim = jaccard(ht, tokenize(baselinePool[bi]!.guardedContent));
      candidates.push({ h: hi, b: bi, sim });
    }
  }
  candidates.sort((x, y) => y.sim - x.sim || x.h - y.h || x.b - y.b);
  const usedH = new Set<number>();
  const usedB = new Set<number>();
  const pairs: SuppressionPair[] = [];
  for (const c of candidates) {
    if (usedH.has(c.h) || usedB.has(c.b)) continue;
    usedH.add(c.h);
    usedB.add(c.b);
    pairs.push({ head: headPool[c.h]!, baseline: baselinePool[c.b]!, similarity: c.sim });
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
