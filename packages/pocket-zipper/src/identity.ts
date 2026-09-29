import { createHash } from "node:crypto";
import type { SuppressionType } from "./types.js";

/**
 * **Suppression continuity** is judged by a suppression's canonical identity:
 * its directive's form plus its (order- and whitespace-normalized) rule set.
 *
 * This module owns that identity — the text a fingerprint is taken over, and the
 * match key built on top of it. It has no opinion about where a suppression sits
 * or what code it guards; the matcher that compares two of these is
 * `continuity.ts`.
 *
 * The fingerprint is versioned (`v1:`) and line-independent by construction:
 * justification, path, position, and guarded content are excluded, so drift,
 * rename, rewrite, and justification edits never change it. Two identical
 * directives in a file therefore share a fingerprint, and identity is a fungible
 * pool rather than a position.
 */

const FINGERPRINT_PREFIX = "v1:sha256:";

function normalizeRuleTokens(tokens: string[]): string[] {
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
