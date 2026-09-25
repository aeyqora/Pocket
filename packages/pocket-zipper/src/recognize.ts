import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { configError } from "./errors.js";
import {
  canonicalConfigOffText,
  canonicalDirectiveText,
  fingerprintOf,
  normalizedPatterns,
  normalizeWhitespace,
  parseDirectiveArgs,
  scopeKeyOf,
} from "./identity.js";
import { severityOf, type EslintComment, type EslintSession } from "./eslint.js";
import { eslintError } from "./errors.js";
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

export function applicableRules(cfg: { rules?: Record<string, unknown> }): string[] {
  const out: string[] = [];
  for (const [rule, value] of Object.entries(cfg.rules ?? {})) {
    if (severityOf(value) > 0) out.push(rule);
  }
  out.sort();
  return out;
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
  const { rules, justification } = parseDirectiveArgs(m[2] ?? "");
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

  const emit = (
    block: { namedRules: string[]; justification: string; line: number; endLine: number },
    form: "block" | "file-level directive",
    guardEnd: number,
  ): void => {
    out.push({
      form,
      namedRules: block.namedRules,
      justification: block.justification,
      line: block.line,
      guardStart: block.endLine + 1,
      guardEnd,
    });
  };

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
      // An unnamed enable closes every open block; a named enable re-enables
      // only the named rules, so a `disable a, b` / `enable a` leaves `b`
      // suppressed to EOF (ESLint's semantics).
      for (let i = openBlocks.length - 1; i >= 0; i--) {
        const block = openBlocks[i]!;
        const guardEnd = Math.max(block.endLine, p.line - 1);
        if (p.rules.length === 0) {
          emit(block, "block", guardEnd);
          openBlocks.splice(i, 1);
          continue;
        }
        if (block.namedRules.length === 0) continue; // broad block: named enable is partial
        const closed = block.namedRules.filter((r) => p.rules.includes(r));
        if (closed.length === 0) continue;
        emit({ ...block, namedRules: closed }, "block", guardEnd);
        block.namedRules = block.namedRules.filter((r) => !p.rules.includes(r));
        if (block.namedRules.length === 0) openBlocks.splice(i, 1);
      }
    }
  }

  for (const block of openBlocks) emit(block, "file-level directive", totalLines);

  return out;
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
// Per-file recognition
// ---------------------------------------------------------------------------

export interface RecognizeFileInput {
  session: EslintSession;
  /** The tree the file lives in, root the paths ESLint sees resolve against. */
  treeDir: string;
  relFile: string;
  content: string;
}

export interface RecognizeFileResult {
  /** The logical suppressions the file declares, one per guarded rule. */
  suppressions: LogicalSuppression[];
  /** Rules ESLint's effective configuration applies to this file. */
  applicable: string[];
}

/**
 * The one recognition pass over one file: ESLint for what is applicable and
 * what a directive silences, the linter for the comments, then the directive
 * grammar. Shared by every surface that inventories a tree, so no two can
 * disagree about what a file contains — and it fails closed when ESLint
 * acknowledged a suppression the inventory does not carry: a "pass" must never
 * mean "we didn't look".
 */
export async function recognizeFile(input: RecognizeFileInput): Promise<RecognizeFileResult> {
  const { session, treeDir, relFile, content } = input;
  const filePath = join(treeDir, relFile);
  const { used, unused } = await session.lint(content, filePath);
  const cfg = await session.effectiveConfig(filePath);
  const applicable = new Set(applicableRules(cfg));
  const comments = session.comments(content, filePath, cfg.languageOptions);
  const found = recognizeDirectives({ file: relFile, code: content, cfg, comments });
  const inventoried = new Set(found.map((s) => s.rule));
  const assertInventoried = (rule: string, shape: string): void => {
    if (applicable.has(rule) && !inventoried.has(rule)) {
      throw eslintError(
        `recognition missed a ${shape} logical suppression for rule '${rule}' in ${relFile}`,
      );
    }
  };
  for (const message of used) {
    const rule = message.ruleId;
    if (!rule) continue;
    const viaDirective = (message.suppressions ?? []).some((s) => s.kind === "directive");
    if (viaDirective) assertInventoried(rule, "used");
  }
  for (const directive of unused) {
    if (directive.isEnable) continue;
    for (const rule of directive.ruleNames) assertInventoried(rule, "unused");
  }
  return { suppressions: found, applicable: [...applicable] };
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
  /** Configured severity: 0 off, 1 warn, 2 error. */
  sev: number;
}

export interface ConfigOffDeclaration {
  rule: string;
  scopeKey: string;
  file: string;
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
      decls.push({
        rule,
        files,
        ignores,
        index,
        off: severityOf(value) === 0,
        sev: severityOf(value),
      });
    }
  });
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

/**
 * Rule ids contributed by plugins declared in the flat config, so an allowlist
 * naming a plugin rule can be validated (a typo is then an unrecognized rule).
 */
export async function configPluginRuleNames(treeDir: string): Promise<Set<string>> {
  const configFile = findConfigFile(treeDir);
  if (!configFile || !FLAT_CONFIG_NAMES.includes(configFile)) return new Set();
  let raw: unknown;
  try {
    raw = await loadConfigValue(treeDir, configFile);
  } catch {
    return new Set();
  }
  const entries = Array.isArray(raw) ? raw : [raw];
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const plugins = (entry as Record<string, unknown>)["plugins"];
    if (!plugins || typeof plugins !== "object") continue;
    for (const [prefix, plugin] of Object.entries(plugins as Record<string, unknown>)) {
      const rules = (plugin as { rules?: Record<string, unknown> } | null)?.rules;
      if (rules && typeof rules === "object") {
        for (const rule of Object.keys(rules)) names.add(`${prefix}/${rule}`);
      }
    }
  }
  return names;
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
  const decls = collectFlatDecls(raw);
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

/**
 * A rule's configured severity (0 off, 1 warn, 2 error) at a config scope, as
 * it *effectively* applies once later declarations have had their say. Scopes
 * are identified by their exact `files`/`ignores` patterns (the same identity
 * the config-off inventory uses), so severity can be compared across trees.
 */
export interface ConfigSeverityLevel {
  rule: string;
  files: string[] | null;
  ignores: string[] | null;
  band: number;
}

/**
 * Every severity band currently in effect in the flat config. Used by
 * policy-change detection: a band that drops (error -> warn, warn -> off,
 * error -> off) is a weakening of the governed surface — not just a literal
 * `"off"`, which is why this reads bands rather than reusing the config-off
 * inventory.
 *
 * Override semantics match the flat config's own merge order: a later
 * declaration replaces an earlier one that covers the same files. A global
 * declaration (no `files`) covers every scope; a scoped declaration covers
 * only its own — so a later global absorbs every older scoped declaration,
 * and a later scoped declaration only absorbs older same-scope ones.
 */
export async function configSeverityLevels(treeDir: string): Promise<ConfigSeverityLevel[]> {
  const configFile = findConfigFile(treeDir);
  if (!configFile) return [];
  let raw: unknown;
  try {
    raw = await loadConfigValue(treeDir, configFile);
  } catch (err) {
    throw configError(`failed to load ESLint config '${configFile}'`, String(err));
  }
  const decls = collectFlatDecls(raw);
  const byRule = new Map<string, ConfigDecl[]>();
  for (const d of decls) {
    const list = byRule.get(d.rule);
    if (list) list.push(d);
    else byRule.set(d.rule, [d]);
  }
  const levels: ConfigSeverityLevel[] = [];
  for (const entries of byRule.values()) {
    const globals = entries.filter((d) => d.files === null);
    if (globals.length > 0) {
      const last = globals.reduce((a, b) => (b.index > a.index ? b : a));
      levels.push({ rule: last.rule, files: last.files, ignores: last.ignores, band: last.sev });
    }
    const latestAtScope = new Map<string, ConfigDecl>();
    for (const d of entries) {
      if (d.files === null) continue;
      const scope = scopeKey(d.files, d.ignores);
      const prior = latestAtScope.get(scope);
      if (!prior || d.index > prior.index) latestAtScope.set(scope, d);
    }
    for (const d of latestAtScope.values()) {
      // A later global covers this scope too; the global level above already
      // represents it, so the scoped declaration is absorbed.
      if (globals.some((g) => g.index > d.index)) continue;
      levels.push({ rule: d.rule, files: d.files, ignores: d.ignores, band: d.sev });
    }
  }
  return levels;
}

function scopeKey(files: string[] | null, ignores: string[] | null): string {
  return JSON.stringify({
    files: normalizedPatterns(files),
    ignores: normalizedPatterns(ignores),
  });
}

function findConfigFile(treeDir: string): string | null {
  for (const name of FLAT_CONFIG_NAMES) {
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
