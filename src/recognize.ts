import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { configError } from "./errors.js";
import {
  canonicalConfigOffText,
  canonicalDirectiveText,
  fingerprintOf,
  normalizeRuleTokens,
  normalizeWhitespace,
} from "./identity.js";
import { severityOf, type EslintComment, type EslintSession } from "./eslint.js";
import type { LogicalSuppression, SuppressionType } from "./types.js";

type DirectiveForm = Exclude<SuppressionType, "config-off">;

interface DirectiveInstance {
  form: DirectiveForm;
  namedRules: string[];
  justification: string;
  line: number;
  guardStart: number;
  guardEnd: number;
}

const FLAT_CONFIG_NAMES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
];

const LEGACY_CONFIG_NAMES = [
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".eslintrc.cjs",
  ".eslintrc.js",
];

export function applicableRules(cfg: { rules?: Record<string, unknown> }): string[] {
  const out: string[] = [];
  for (const [rule, value] of Object.entries(cfg.rules ?? {})) {
    if (severityOf(value) > 0) out.push(rule);
  }
  out.sort();
  return out;
}

function splitDirectiveArgs(raw: string): { rules: string[]; justification: string } {
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

interface ParsedComment {
  label: string;
  rules: string[];
  justification: string;
  line: number;
  endLine: number;
  type: "Line" | "Block";
}

function parseComment(comment: EslintComment): ParsedComment | null {
  const value = comment.value;
  const m = /^\s*eslint-(disable-next-line|disable-line|disable|enable)\b([\s\S]*)$/.exec(
    value,
  );
  if (!m) return null;
  const label = `eslint-${m[1]}`;
  if (comment.type === "Shebang") return null;
  if (comment.type === "Line" && label !== "eslint-disable-next-line" && label !== "eslint-disable-line") {
    return null;
  }
  // ESLint refuses an `eslint-disable-line` comment that spans multiple lines
  // (it emits a directive-format error and suppresses nothing).
  if (label === "eslint-disable-line" && comment.loc.end.line > comment.loc.start.line) {
    return null;
  }
  const { rules, justification } = splitDirectiveArgs(m[2] ?? "");
  return {
    label,
    rules,
    justification,
    line: comment.loc.start.line,
    endLine: comment.loc.end.line,
    type: comment.type,
  };
}

export function parseDirectiveComments(
  comments: EslintComment[],
  totalLines: number,
): DirectiveInstance[] {
  const parsed = comments
    .map((c) => ({ comment: c, p: parseComment(c) }))
    .filter((x): x is { comment: EslintComment; p: ParsedComment } => x.p !== null)
    .sort((a, b) => a.comment.range[0] - b.comment.range[0]);

  const out: DirectiveInstance[] = [];
  const openBlocks: Array<{
    namedRules: string[];
    justification: string;
    line: number;
    endLine: number;
  }> = [];

  for (const { p } of parsed) {
    if (p.label === "eslint-disable-next-line") {
      out.push({
        form: "next-line",
        namedRules: p.rules,
        justification: p.justification,
        line: p.line,
        guardStart: p.line + 1,
        guardEnd: p.line + 1,
      });
    } else if (p.label === "eslint-disable-line") {
      out.push({
        form: "line",
        namedRules: p.rules,
        justification: p.justification,
        line: p.line,
        guardStart: p.line,
        guardEnd: p.line,
      });
    } else if (p.label === "eslint-disable") {
      openBlocks.push({
        namedRules: p.rules,
        justification: p.justification,
        line: p.line,
        endLine: p.endLine,
      });
    } else if (p.label === "eslint-enable") {
      const idx = lastOpenBlockIndex(openBlocks, p.rules);
      if (idx >= 0) {
        const block = openBlocks[idx]!;
        openBlocks.splice(idx, 1);
        out.push({
          form: "block",
          namedRules: block.namedRules,
          justification: block.justification,
          line: block.line,
          guardStart: block.endLine + 1,
          guardEnd: Math.max(block.endLine, p.line - 1),
        });
      }
    }
  }

  for (const block of openBlocks) {
    out.push({
      form: "file-level directive",
      namedRules: block.namedRules,
      justification: block.justification,
      line: block.line,
      guardStart: block.endLine + 1,
      guardEnd: totalLines,
    });
  }

  return out;
}

function lastOpenBlockIndex(
  openBlocks: Array<{ namedRules: string[]; justification: string; line: number }>,
  enableRules: string[],
): number {
  for (let i = openBlocks.length - 1; i >= 0; i--) {
    const b = openBlocks[i]!;
    if (enableRules.length === 0 || b.namedRules.length === 0) return i;
    if (enableRules.some((r) => b.namedRules.includes(r))) return i;
  }
  return openBlocks.length - 1;
}

function guardedContentFor(
  lines: string[],
  inst: DirectiveInstance,
): string {
  const start = Math.max(1, inst.guardStart);
  const end = Math.min(lines.length, inst.guardEnd);
  const parts: string[] = [];
  for (let i = start; i <= end; i++) {
    const text = lines[i - 1] ?? "";
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    if (/^\/[*/]?\s*eslint-/.test(trimmed) || /^\/\*+\s*eslint-/.test(trimmed)) continue;
    parts.push(trimmed);
  }
  return normalizeWhitespace(parts.join("\n"));
}

export interface RecognizeDirectivesInput {
  file: string;
  code: string;
  cfg: { rules?: Record<string, unknown>; linterOptions?: Record<string, unknown>; languageOptions?: Record<string, unknown> };
  comments: EslintComment[];
}

export function recognizeDirectives(input: RecognizeDirectivesInput): LogicalSuppression[] {
  const { file, code, cfg, comments } = input;
  if (cfg.linterOptions && cfg.linterOptions["noInlineConfig"] === true) return [];
  const lines = code.split(/\r?\n/);
  const applicable = applicableRules(cfg);
  const instances = parseDirectiveComments(comments, lines.length);
  const out: LogicalSuppression[] = [];
  for (const inst of instances) {
    const guardedRules =
      inst.namedRules.length === 0
        ? applicable
        : inst.namedRules.filter((r) => applicable.includes(r));
    const guardedContent = guardedContentFor(lines, inst);
    for (const rule of guardedRules) {
      // Each logical suppression is identified by its form and its own rule
      // token, so adding one rule to a multi-rule directive creates exactly one
      // new suppression without invalidating its siblings.
      const canonicalText = canonicalDirectiveText(inst.form, [rule]);
      const fingerprint = fingerprintOf(canonicalText);
      out.push({
        fingerprint,
        rule,
        suppressionType: inst.form,
        guardKind: "directive",
        file,
        line: inst.line,
        guardStart: inst.guardStart,
        guardEnd: inst.guardEnd,
        guardedContent,
        justification: inst.justification,
        canonicalText,
        namedRules: inst.namedRules,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config-level off recognition
// ---------------------------------------------------------------------------

interface ConfigDecl {
  rule: string;
  files: string[] | null;
  ignores: string[] | null;
  index: number;
  off: boolean;
}

export interface ConfigOffDeclaration {
  rule: string;
  scopeKey: string;
  file: string;
}

function normalizedPatterns(patterns: string[] | null | undefined): string[] | null {
  return patterns ? [...patterns].map((s) => s.trim()).sort() : null;
}

export function scopeKeyOf(configFile: string, files: string[] | null, ignores: string[] | null): string {
  return JSON.stringify({
    config: configFile,
    files: normalizedPatterns(files),
    ignores: normalizedPatterns(ignores),
  });
}

function normalizePatterns(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return null;
}

function collectFlatDecls(config: unknown): ConfigDecl[] {
  const entries = Array.isArray(config) ? config : [config];
  const decls: ConfigDecl[] = [];
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const obj = entry as Record<string, unknown>;
    const rules = obj["rules"];
    if (!rules || typeof rules !== "object") return;
    const files = normalizePatterns(obj["files"]);
    const ignores = normalizePatterns(obj["ignores"]);
    for (const [rule, value] of Object.entries(rules as Record<string, unknown>)) {
      decls.push({ rule, files, ignores, index, off: severityOf(value) === 0 });
    }
  });
  return decls;
}

function legacyDecls(config: unknown): ConfigDecl[] {
  const decls: ConfigDecl[] = [];
  const root = (config ?? {}) as Record<string, unknown>;
  const rootRules = root["rules"];
  const rootFiles = normalizePatterns(root["files"]);
  const rootIgnores = normalizePatterns(root["ignorePatterns"]);
  if (rootRules && typeof rootRules === "object") {
    for (const [rule, value] of Object.entries(rootRules as Record<string, unknown>)) {
      decls.push({
        rule,
        files: rootFiles,
        ignores: rootIgnores,
        index: 0,
        off: severityOf(value) === 0,
      });
    }
  }
  const overrides = root["overrides"];
  if (Array.isArray(overrides)) {
    overrides.forEach((ov, index) => {
      if (!ov || typeof ov !== "object") return;
      const o = ov as Record<string, unknown>;
      const files = normalizePatterns(o["files"]);
      const ignores = normalizePatterns(o["excludedFiles"]);
      const rules = o["rules"];
      if (!rules || typeof rules !== "object") return;
      for (const [rule, value] of Object.entries(rules as Record<string, unknown>)) {
        decls.push({
          rule,
          files,
          ignores,
          index: index + 1,
          off: severityOf(value) === 0,
        });
      }
    });
  }
  return decls;
}

function sameScope(a: ConfigDecl, b: ConfigDecl): boolean {
  const key = (v: string[] | null) => JSON.stringify(normalizedPatterns(v));
  return key(a.files) === key(b.files) && key(a.ignores) === key(b.ignores);
}

function isReEnabled(decls: ConfigDecl[], off: ConfigDecl): boolean {
  for (const d of decls) {
    if (d.rule !== off.rule || d.off || d.index <= off.index) continue;
    // A later global `on` overrides every scope.
    if (d.files === null) return true;
    // A later scoped `on` overrides an equal-scope `off`; a global off remains
    // effective for every scope the override does not cover.
    if (off.files !== null && sameScope(d, off)) return true;
  }
  return false;
}

export interface ConfigOffResult {
  suppressions: LogicalSuppression[];
  configFile: string | null;
}

export async function recognizeConfigOffs(treeDir: string): Promise<ConfigOffResult> {
  const configFile = findConfigFile(treeDir);
  if (!configFile) return { suppressions: [], configFile: null };
  let raw: unknown;
  try {
    raw = await loadConfigValue(treeDir, configFile);
  } catch (err) {
    throw configError(`failed to load ESLint config '${configFile}'`, String(err));
  }
  const isFlat = FLAT_CONFIG_NAMES.includes(configFile);
  const decls = isFlat ? collectFlatDecls(raw) : legacyDecls(raw);
  const suppressions: LogicalSuppression[] = [];
  for (const decl of decls) {
    if (!decl.off) continue;
    if (isReEnabled(decls, decl)) continue;
    const scopeKey = scopeKeyOf(configFile, decl.files, decl.ignores);
    const canonicalText = canonicalConfigOffText(decl.rule, scopeKey);
    suppressions.push({
      fingerprint: fingerprintOf(canonicalText),
      rule: decl.rule,
      suppressionType: "config-off",
      guardKind: "config-level",
      file: configFile,
      line: 1,
      guardStart: 1,
      guardEnd: 1,
      guardedContent: normalizeWhitespace(`${decl.rule} ${scopeKey}`),
      justification: "",
      canonicalText,
      namedRules: [decl.rule],
      scopeKey,
    });
  }
  return { suppressions, configFile };
}

function findConfigFile(treeDir: string): string | null {
  for (const name of [...FLAT_CONFIG_NAMES, ...LEGACY_CONFIG_NAMES]) {
    if (existsSync(join(treeDir, name))) return name;
  }
  return null;
}

async function loadConfigValue(treeDir: string, configFile: string): Promise<unknown> {
  const abs = join(treeDir, configFile);
  if (configFile.endsWith(".json")) {
    const fs = await import("node:fs/promises");
    return JSON.parse(await fs.readFile(abs, "utf8"));
  }
  if (configFile.endsWith(".yml") || configFile.endsWith(".yaml")) {
    const fs = await import("node:fs/promises");
    return parseYaml(await fs.readFile(abs, "utf8"));
  }
  const version = statSync(abs).mtimeMs;
  const mod = (await import(`${pathToFileURL(abs).href}?t=${version}`)) as {
    default?: unknown;
  };
  const value = mod.default ?? mod;
  if (typeof value === "function") {
    return await (value as (args?: unknown) => unknown)();
  }
  return value;
}

export type { EslintSession };
