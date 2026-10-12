import { readFileSync, writeFileSync } from "node:fs";
import { lintFiles, type DroppedFile, type FatalFile } from "./eslint.js";
import { formatDirective, scanDirectives, splitRuleList } from "./scan.js";
import type { ScannedDirective } from "./scan.js";
import type { ESLint } from "eslint";
import type {
  Action,
  BatchOutcome,
  DirectiveForm,
  EditRecord,
  JsonValue,
  LintMessage,
  NotActionableDirective,
  RunMode,
} from "./types.js";

/**
 * Per-action strategy parameters. Suppress' shape is pinned here now; later
 * tickets add one type per action and widen the union additively.
 */
export type SuppressParams = {
  /** Appended to **inserted** directives only: ` -- <text>` (spec §4/§6.1). */
  reason?: string;
  /**
   * Ticket 08: prepend into the enclosing `block`/`file-level` guard instead of
   * the default minimal-span insert. Declared now so the seam is stable; the
   * bounded upward scan is ticket 08's work, not this ticket's.
   */
  reuseBlocks?: boolean;
  /**
   * Ticket 08: handled *above* the engine (lint with `fix: true`, re-lint, then
   * suppress the remainder — spec §6.1). The engine never sees it.
   */
  fixFirst?: boolean;
};

export type StrategyParams = JsonValue;

/** The exact seam from the architecture notes: plan+apply for one file. */
export interface RunActionForFileOptions {
  action: Action;
  params: StrategyParams;
  filePath: string;
  text: string;
  messages: LintMessage[];
  /** Reserved: the caller owns the write; the strategy only reports the text. */
  apply: boolean;
}

export interface RunActionResult {
  /** The file's text after the strategy's plan. Equal to `text` when unchanged. */
  output: string;
  edits: EditRecord[];
  stats: Record<string, number>;
  /** Directives recognised but left untouched, for the command to report. */
  notActionable?: NotActionableDirective[];
}

type Strategy = (options: RunActionForFileOptions) => RunActionResult;

// --- directive grammar (shared with ticket 08/09) -----------------------------

/**
 * A whole-line directive: `// eslint-disable-next-line <rules> [ -- desc]` or
 * the `/* ... *\/` spelling, and the `-line` form. Deliberately does **not**
 * match block/file-level directives (`eslint-disable` with no `-next-line`/`-line`
 * suffix) nor bare `eslint-disable` — those are spans, handled elsewhere.
 */
export const NEXT_LINE_DIRECTIVE_RE =
  /^(\s*)(?:\/\/|\/\*)\s*eslint-disable-(next-line|line)\b\s*(.*?)\s*(?:\*\/)?\s*$/;

/**
 * The `line` form riding at the end of a code line:
 * `<code> // eslint-disable-line <rules> [ -- desc]`. Group 1 is the code
 * prefix up to its last non-space character.
 */
export const LINE_SUFFIX_DIRECTIVE_RE = /^(\s*.*\S)\s+\/\/\s*eslint-disable-line\b\s*(.*)$/;

// `splitRuleList` lives in `scan.ts` (the shared full-file scan) so the engine
// can import it without a cycle; re-exported here to keep the public surface.
export { splitRuleList } from "./scan.js";
export type { RuleList } from "./scan.js";

// --- lazy scan (the −32% lever) ----------------------------------------------

export interface LineGuard {
  /** The directive line's text without a trailing CR (never rewritten raw). */
  text: string;
  /** Code prefix preceding the comment (group 1). */
  code: string;
  rules: string[];
  desc: string;
  bare: boolean;
  /** The line ended in CRLF. */
  cr: boolean;
}

export interface NextLineGuard {
  /** The directive line's text without a trailing CR (never rewritten raw). */
  text: string;
  /** Indentation preceding the comment. */
  indent: string;
  rules: string[];
  desc: string;
  bare: boolean;
  cr: boolean;
}

/** One violation line and the guards the lazy scan found for it. */
export interface SuppressTarget {
  /** 1-based violation line (the ledger anchor). */
  line: number;
  /** Actionable rules on the line, in first-seen order. */
  rules: string[];
  /** The violation line's leading whitespace (used for insert indentation). */
  indent: string;
  /** The violation line ended in CRLF. */
  cr: boolean;
  /** A `line`-form directive on the violation's own line. */
  lineGuard?: LineGuard;
  /** A `next-line`-form directive on the line above. */
  nextLineGuard?: NextLineGuard;
}

/** Strip one trailing CR (CRLF files keep the CR on the stored line). */
function stripCr(line: string): { probe: string; cr: boolean } {
  return line.endsWith("\r") ? { probe: line.slice(0, -1), cr: true } : { probe: line, cr: false };
}

function leadingWhitespace(line: string): string {
  const match = /^\s*/.exec(line);
  return match === null ? "" : match[0];
}

/**
 * The lazy per-target scan (spec §6.1, §7): aggregate the file's actionable
 * messages by line, then regex **only the violation's own line and the line
 * above** for a guard — never the whole file. Where a `line`-form guard rides on
 * the violation's own line, the line above is not even read (guard order, §6.1).
 *
 * Reading `lines` is intentionally limited to indices `line - 1` and `line - 2`
 * so the laziness is a property of the code, not an aspiration.
 */
export function scanSuppressFile(
  lines: readonly string[],
  messages: readonly LintMessage[],
): SuppressTarget[] {
  const byLine = new Map<number, string[]>();
  const seen = new Map<number, Set<string>>();
  for (const message of messages) {
    if (message.severity < 1) continue;
    if (message.ruleId === null || message.ruleId === undefined) continue;
    if (typeof message.line !== "number") continue;
    let rules = byLine.get(message.line);
    if (rules === undefined) {
      rules = [];
      byLine.set(message.line, rules);
      seen.set(message.line, new Set());
    }
    const present = seen.get(message.line)!;
    if (!present.has(message.ruleId)) {
      present.add(message.ruleId);
      rules.push(message.ruleId);
    }
  }

  const targets: SuppressTarget[] = [];
  for (const [line, rules] of byLine) {
    const own = stripCr(lines[line - 1] ?? "");
    const target: SuppressTarget = {
      line,
      rules,
      indent: leadingWhitespace(own.probe),
      cr: own.cr,
    };

    const suffix = LINE_SUFFIX_DIRECTIVE_RE.exec(own.probe);
    if (suffix !== null) {
      const { rules: listed, desc, bare } = splitRuleList(suffix[2] ?? "");
      target.lineGuard = { text: own.probe, code: suffix[1] ?? "", rules: listed, desc, bare, cr: own.cr };
    } else {
      const above = stripCr(lines[line - 2] ?? "");
      const whole = NEXT_LINE_DIRECTIVE_RE.exec(above.probe);
      // A `line`-form whole comment on the line above guards its own line, not
      // this violation — only `next-line` counts here.
      if (whole !== null && whole[2] === "next-line") {
        const { rules: listed, desc, bare } = splitRuleList(whole[3] ?? "");
        target.nextLineGuard = {
          text: above.probe,
          indent: whole[1] ?? "",
          rules: listed,
          desc,
          bare,
          cr: above.cr,
        };
      }
    }
    targets.push(target);
  }
  return targets;
}

// --- plan ---------------------------------------------------------------------

export type SuppressEditKind = "insert" | "prepend-line" | "prepend-next";

/** One planned directive edit, with its rendered before/after text. */
export interface PlannedEdit {
  kind: SuppressEditKind;
  /** 1-based violation line the edit anchors to (the ledger's `line`). */
  line: number;
  /** 0-based index of the line rewritten (prepend) or spliced before (insert). */
  index: number;
  /** Rules this edit adds, in order (all rules for an insert; the missing ones for a prepend). */
  added: string[];
  /** The directive line's text after the edit (full line, CR included). */
  after: string;
  /** The directive line's text before the edit; absent for an insert. */
  before?: string;
  form: DirectiveForm;
}

export interface SuppressPlan {
  edits: PlannedEdit[];
  /** Lines skipped because the guard was bare (no rule list): defensive. */
  skippedBare: number;
  /** Lines skipped because the guard already listed every rule: idempotent. */
  skippedGuarded: number;
}

/**
 * The guard decision, in spec §6.1 order: a `line` guard on the violation's own
 * line, then a `next-line` guard on the line above. Bare guards and
 * already-complete guards are skip-only (defensive: ESLint never surfaces a
 * suppressed violation as a message, so both are unreachable from lint output).
 * A missing rule is prepended at position 0, preserving existing order and any
 * trailing `-- description`.
 *
 * `--reuse-blocks` (ticket 08) is intentionally not implemented here: the
 * default minimal-span insert is the fall-through when no line-local guard
 * exists, whether or not the line sits inside a span.
 */
export function planSuppressEdits(
  targets: readonly SuppressTarget[],
  params: SuppressParams,
): SuppressPlan {
  const reason = params.reason ? ` -- ${params.reason}` : "";
  const edits: PlannedEdit[] = [];
  let skippedBare = 0;
  let skippedGuarded = 0;

  for (const target of targets) {
    const lineGuard = target.lineGuard;
    if (lineGuard !== undefined) {
      if (lineGuard.bare) {
        skippedBare += 1;
        continue;
      }
      const missing = target.rules.filter((rule) => !lineGuard.rules.includes(rule));
      if (missing.length === 0) {
        skippedGuarded += 1;
        continue;
      }
      const all = [...missing, ...lineGuard.rules];
      const desc = lineGuard.desc ? ` -- ${lineGuard.desc}` : "";
      const cr = lineGuard.cr ? "\r" : "";
      edits.push({
        kind: "prepend-line",
        line: target.line,
        index: target.line - 1,
        added: missing,
        before: lineGuard.text + cr,
        after: `${lineGuard.code} // eslint-disable-line ${all.join(", ")}${desc}${cr}`,
        form: "line",
      });
      continue;
    }

    const nextLine = target.nextLineGuard;
    if (nextLine !== undefined) {
      if (nextLine.bare) {
        skippedBare += 1;
        continue;
      }
      const missing = target.rules.filter((rule) => !nextLine.rules.includes(rule));
      if (missing.length === 0) {
        skippedGuarded += 1;
        continue;
      }
      const all = [...missing, ...nextLine.rules];
      const desc = nextLine.desc ? ` -- ${nextLine.desc}` : "";
      const cr = nextLine.cr ? "\r" : "";
      edits.push({
        kind: "prepend-next",
        line: target.line,
        index: target.line - 2,
        added: missing,
        before: nextLine.text + cr,
        after: `${nextLine.indent}// eslint-disable-next-line ${all.join(", ")}${desc}${cr}`,
        form: "next-line",
      });
      continue;
    }

    // No guard: the minimal-span insert — one directive suppressing exactly this
    // line, indented to match it (spec §6.1). This is also the default for
    // violations inside a block span or under a file-level directive.
    edits.push({
      kind: "insert",
      line: target.line,
      index: target.line - 1,
      added: [...target.rules],
      after: `${target.indent}// eslint-disable-next-line ${target.rules.join(", ")}${reason}${
        target.cr ? "\r" : ""
      }`,
      form: "next-line",
    });
  }

  return { edits, skippedBare, skippedGuarded };
}

// --- apply --------------------------------------------------------------------

/**
 * Apply planned edits to a split file, bottom-up (descending line index) so an
 * insert never invalidates a later edit's index (spec §7). Prepend rewrites a
 * line in place; insert splices a new line before the violation.
 */
export function applySuppressEdits(lines: string[], edits: readonly PlannedEdit[]): void {
  const ordered = [...edits].sort((a, b) => b.index - a.index);
  for (const edit of ordered) {
    if (edit.kind === "insert") lines.splice(edit.index, 0, edit.after);
    else lines[edit.index] = edit.after;
  }
}

// --- ledger -------------------------------------------------------------------

/** One `EditRecord` per rule the edit adds, sharing the edit's other fields. */
export function ledgerRecordsForEdit(file: string, edit: PlannedEdit): EditRecord[] {
  const editType = edit.kind === "insert" ? "insert" : "prepend";
  return edit.added.map((rule) => ({
    file,
    line: edit.line,
    rule,
    editType,
    form: edit.form,
    ...(edit.before === undefined ? {} : { before: edit.before }),
    after: edit.after,
  }));
}

// --- strategy -----------------------------------------------------------------

function suppressParams(raw: StrategyParams): SuppressParams {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as SuppressParams;
  }
  return {};
}

/** The suppress strategy: scan → plan → apply, split-once, ledger every edit. */
function suppressStrategy(options: RunActionForFileOptions): RunActionResult {
  const params = suppressParams(options.params);
  const lines = options.text.split("\n");
  const targets = scanSuppressFile(lines, options.messages);
  const { edits, skippedBare, skippedGuarded } = planSuppressEdits(targets, params);

  const records: EditRecord[] = [];
  for (const edit of edits) records.push(...ledgerRecordsForEdit(options.filePath, edit));
  applySuppressEdits(lines, edits);

  let inserted = 0;
  for (const edit of edits) if (edit.kind === "insert") inserted += 1;

  return {
    output: edits.length === 0 ? options.text : lines.join("\n"),
    edits: records,
    // Counters are per *directive* edit (one per violation line, matching the
    // spike), while `edits` holds one record per rule. A multi-rule line is one
    // `inserted` here and several records above.
    stats: {
      inserted,
      prepended: edits.length - inserted,
      skippedBare,
      skippedGuarded,
    },
  };
}

/**
 * The `remove` verb's parameters (spec §6.3): the action config's actionable
 * rules to strip from every directive. Passed to the workers as cloneable JSON.
 */
export interface RemoveParams {
  rules: string[];
}

/** One planned remove edit: rewrite a directive's list, or delete the comment. */
type RemoveEdit = {
  kind: "rewrite" | "delete";
  index: number;
  line: number;
  form: DirectiveForm;
  removed: string[];
  before: string;
  /**
   * A rewrite's new line. A whole-line delete has none (the line is spliced
   * out); a suffix delete keeps the code line, so `after` is that code prefix.
   */
  after?: string;
};

function removeParams(raw: StrategyParams): RemoveParams {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const rules = (raw as { rules?: unknown }).rules;
    if (Array.isArray(rules)) {
      return { rules: rules.filter((rule): rule is string => typeof rule === "string") };
    }
  }
  return { rules: [] };
}

/**
 * The remove strategy (spec §6.3): full-file scan, strip the config's rules from
 * every disable directive, delete a directive whose list empties, and delete a
 * paired `eslint-enable` when its block-open vanishes. A bare `eslint-disable` is
 * never produced — it guards everything — and bare directives are left untouched
 * and reported.
 *
 * Block pairing comes from `scanDirectives`: an enable is deleted only when
 * **every** disable it closes is itself deleted, so removing one rule from a
 * multi-rule block never strands the other rules by dropping their closer.
 */
function removeStrategy(options: RunActionForFileOptions): RunActionResult {
  const { rules: configRuleList } = removeParams(options.params);
  const configRules = new Set(configRuleList);
  const lines = options.text.split("\n");
  const directives = scanDirectives(lines);

  const notActionable: NotActionableDirective[] = [];
  const stripped = new Map<number, { directive: ScannedDirective; kept: string[]; removed: string[] }>();
  const deletedDisables = new Map<number, { directive: ScannedDirective; removed: string[] }>();

  for (const directive of directives) {
    if (directive.kind !== "disable") continue;
    if (directive.bare) {
      // A bare guard names no rules, so it cannot be scoped to the config's set.
      notActionable.push({
        file: options.filePath,
        line: directive.line,
        form: directive.form,
        reason: "bare",
        text: directive.text,
      });
      continue;
    }
    const removed = directive.rules.filter((rule) => configRules.has(rule));
    if (removed.length === 0) continue;
    const kept = directive.rules.filter((rule) => !configRules.has(rule));
    if (kept.length === 0) deletedDisables.set(directive.index, { directive, removed });
    else stripped.set(directive.index, { directive, kept, removed });
  }

  const removedByLine = new Map<number, string[]>();
  for (const { directive, removed } of deletedDisables.values()) {
    removedByLine.set(directive.line, removed);
  }

  const deletedEnables = new Map<number, { directive: ScannedDirective; removed: string[] }>();
  for (const directive of directives) {
    if (directive.kind !== "enable") continue;
    const closed = directive.closes;
    // An orphan enable closes nothing: not remove's job (cleanup owns those).
    if (closed === undefined || closed.length === 0) continue;
    if (!closed.every((line) => removedByLine.has(line))) continue;
    const removed = [...new Set(closed.flatMap((line) => removedByLine.get(line) ?? []))];
    deletedEnables.set(directive.index, { directive, removed });
  }

  // A whole-line directive is spliced out entirely; a suffix directive keeps its
  // code and loses only the comment (spec §6.3: delete the directive, not the
  // line it rides on).
  const crOf = (directive: ScannedDirective): string => (directive.cr ? "\r" : "");
  const deleteEdit = (
    directive: ScannedDirective,
    removed: string[],
    form: DirectiveForm,
  ): RemoveEdit => ({
    kind: "delete",
    index: directive.index,
    line: directive.line,
    form,
    removed,
    before: directive.text + crOf(directive),
    ...(directive.suffix ? { after: `${directive.code}${crOf(directive)}` } : {}),
  });

  const edits: RemoveEdit[] = [];
  for (const { directive, kept, removed } of stripped.values()) {
    edits.push({
      kind: "rewrite",
      index: directive.index,
      line: directive.line,
      form: directive.form,
      removed,
      before: directive.text + crOf(directive),
      after: formatDirective(directive, kept),
    });
  }
  for (const { directive, removed } of deletedDisables.values()) {
    edits.push(deleteEdit(directive, removed, directive.form));
  }
  for (const { directive, removed } of deletedEnables.values()) {
    edits.push(deleteEdit(directive, removed, "block"));
  }
  edits.sort((a, b) => a.index - b.index);

  const records: EditRecord[] = [];
  for (const edit of edits) {
    for (const rule of edit.removed) {
      records.push({
        file: options.filePath,
        line: edit.line,
        rule,
        editType: "strip",
        form: edit.form,
        before: edit.before,
        ...(edit.after === undefined ? {} : { after: edit.after }),
      });
    }
  }

  const ordered = [...edits].sort((a, b) => b.index - a.index);
  for (const edit of ordered) {
    if (edit.after === undefined) lines.splice(edit.index, 1);
    else lines[edit.index] = edit.after;
  }

  let rulesRemoved = 0;
  for (const entry of stripped.values()) rulesRemoved += entry.removed.length;
  for (const entry of deletedDisables.values()) rulesRemoved += entry.removed.length;

  return {
    output: edits.length === 0 ? options.text : lines.join("\n"),
    edits: records,
    notActionable,
    stats: {
      stripped: stripped.size,
      deleted: deletedDisables.size + deletedEnables.size,
      skippedBare: notActionable.length,
      rulesRemoved,
    },
  };
}

/**
 * The `cleanup` verb's parameters (spec §6.5): the action config's actionable
 * rules, which scope the pruning. Same cloneable shape as `RemoveParams`.
 */
export interface CleanupParams {
  rules: string[];
}

/**
 * The unused-directive message ESLint emits (research 01 Q3): `ruleId: null`,
 * no `messageId`, located at the directive comment's own start. The unused rule
 * names live **only** in the quoted message text. `whole` means the message
 * carried no `from '…'` clause — ESLint's signal for a fully-unused directive
 * (which, for a bare comment, is the only shape it produces).
 */
export interface UnusedDirectiveMessage {
  kind: "disable" | "enable";
  /** Rule names quoted in the message text; empty when the message is whole. */
  rules: string[];
  /** True when no `from '…'` clause was present: the whole comment is unused. */
  whole: boolean;
  /** 1-based line of the directive comment's own start. */
  line: number;
  column?: number;
}

const UNUSED_DISABLE_PREFIX = "Unused eslint-disable directive (no problems were reported";
const UNUSED_ENABLE_PREFIX =
  "Unused eslint-enable directive (no matching eslint-disable directives were found";

/** Pull the quoted rule names out of an ESLint description (`'a' or 'b'`). */
function quotedRuleNames(description: string): string[] {
  return [...description.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

/**
 * Parse an ESLint unused-directive message into its structured shape (research
 * 01 Q3: `ruleId: null`, no `messageId`, names only in the quoted text). Returns
 * `null` for any other message, so a normal violation can never be mistaken for
 * an unused directive.
 */
export function parseUnusedDirectiveMessage(message: LintMessage): UnusedDirectiveMessage | null {
  const text = message.message;
  if (typeof message.line !== "number") return null;

  let kind: "disable" | "enable";
  let marker: string;
  if (text.startsWith(UNUSED_DISABLE_PREFIX)) {
    kind = "disable";
    marker = " reported from ";
  } else if (text.startsWith(UNUSED_ENABLE_PREFIX)) {
    kind = "enable";
    marker = " were found for ";
  } else {
    return null;
  }

  const at = text.indexOf(marker);
  const base: UnusedDirectiveMessage = {
    kind,
    rules: [],
    whole: true,
    line: message.line,
    ...(typeof message.column === "number" ? { column: message.column } : {}),
  };
  if (at < 0) return base;

  // The message always closes with `).`; strip it before reading the list.
  const description = text.slice(at + marker.length, -2);
  const rules = quotedRuleNames(description);
  return rules.length === 0 ? base : { ...base, rules, whole: false };
}

function cleanupParams(raw: StrategyParams): CleanupParams {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const rules = (raw as { rules?: unknown }).rules;
    if (Array.isArray(rules)) {
      return { rules: rules.filter((rule): rule is string => typeof rule === "string") };
    }
  }
  return { rules: [] };
}

/** One aggregated unused report for a single directive line. */
interface UnusedGroup {
  rules: Set<string>;
  whole: boolean;
}

function groupUnused(
  messages: readonly LintMessage[],
  kind: "disable" | "enable",
): Map<number, UnusedGroup> {
  const groups = new Map<number, UnusedGroup>();
  for (const message of messages) {
    const parsed = parseUnusedDirectiveMessage(message);
    if (parsed === null || parsed.kind !== kind) continue;
    let group = groups.get(parsed.line);
    if (group === undefined) {
      group = { rules: new Set(), whole: false };
      groups.set(parsed.line, group);
    }
    if (parsed.whole) group.whole = true;
    for (const rule of parsed.rules) group.rules.add(rule);
  }
  return groups;
}

/**
 * Find the directive a message points at. Unused messages sit at the comment's
 * own line, so the line plus the message kind (`disable`/`enable`) identifies it;
 * two directives never share a line in well-formed source.
 */
function directiveAtLine(
  byLine: Map<number, ScannedDirective[]>,
  line: number,
  kind: "disable" | "enable",
): ScannedDirective | undefined {
  const candidates = byLine.get(line);
  if (candidates === undefined) return undefined;
  return candidates.find((directive) => directive.kind === kind);
}

/** One cleanup edit: rewrite a directive's list, or delete the comment. */
type CleanupEdit = {
  kind: "rewrite" | "delete";
  index: number;
  line: number;
  form: DirectiveForm;
  removed: string[];
  before: string;
  after?: string;
};

/**
 * The cleanup strategy (spec §6.5): prune **unused** disable directives, driven
 * by ESLint's default `reportUnusedDisableDirectives` reporting, and **config-
 * scoped** — only unused rules in the config's set are stripped, so a stale
 * suppression naming a rule the config does not own is left untouched.
 *
 * The unused rule names come from the message text (research 01 Q3); the
 * directive is read at the message's location via the shared full-file scan, its
 * config-listed unused rules are stripped, and the comment is deleted when its
 * list empties. A **bare** directive is deleted whole only when ESLint flags the
 * whole comment unused (the no-description message); a bare directive cleanup
 * cannot scope stays and is reported. Unused `eslint-enable` directives are
 * removed whole, and a still-paired enable loses any rule its pruned disable no
 * longer suppresses — so one apply converges and a re-run is a no-op.
 */
function cleanupStrategy(options: RunActionForFileOptions): RunActionResult {
  const { rules: configRuleList } = cleanupParams(options.params);
  const configRules = new Set(configRuleList);
  const lines = options.text.split("\n");
  const directives = scanDirectives(lines);

  const byLine = new Map<number, ScannedDirective[]>();
  for (const directive of directives) {
    const list = byLine.get(directive.line);
    if (list === undefined) byLine.set(directive.line, [directive]);
    else list.push(directive);
  }

  const disableGroups = groupUnused(options.messages, "disable");
  const enableGroups = groupUnused(options.messages, "enable");

  const stripped = new Map<number, { directive: ScannedDirective; keep: string[]; removed: string[] }>();
  const deletedDisables = new Map<number, { directive: ScannedDirective; removed: string[] }>();
  const strippedEnables = new Map<number, { directive: ScannedDirective; keep: string[]; removed: string[] }>();
  const deletedEnables = new Map<number, { directive: ScannedDirective; removed: string[] }>();

  for (const [line, group] of disableGroups) {
    const directive = directiveAtLine(byLine, line, "disable");
    if (directive === undefined) continue;
    if (directive.bare) {
      // A bare comment names no rules, so it can only be pruned whole when ESLint
      // says the entire comment is unused; otherwise its unused-ness is unscopable.
      if (group.whole) deletedDisables.set(directive.index, { directive, removed: [] });
      continue;
    }
    const unused = group.whole ? new Set(directive.rules) : group.rules;
    const removed = directive.rules.filter((rule) => unused.has(rule) && configRules.has(rule));
    if (removed.length === 0) continue;
    const keep = directive.rules.filter((rule) => !removed.includes(rule));
    if (keep.length === 0) deletedDisables.set(directive.index, { directive, removed });
    else stripped.set(directive.index, { directive, keep, removed });
  }

  // The post-edit rule list of a block-open, keyed by line, so an enable can see
  // what its closed disables still suppress once the disables are pruned.
  const deletedDisableLines = new Set<number>();
  const strippedRulesByLine = new Map<number, string[]>();
  const rulesByDisableLine = new Map<number, string[]>();
  const removedByDisableLine = new Map<number, string[]>();
  for (const { directive, keep, removed } of stripped.values()) {
    strippedRulesByLine.set(directive.line, keep);
    removedByDisableLine.set(directive.line, removed);
  }
  for (const { directive, removed } of deletedDisables.values()) {
    deletedDisableLines.add(directive.line);
    removedByDisableLine.set(directive.line, removed);
  }
  for (const directive of directives) {
    if (directive.kind === "disable") rulesByDisableLine.set(directive.line, directive.rules);
  }
  const postRulesForLine = (line: number): string[] => {
    if (deletedDisableLines.has(line)) return [];
    const kept = strippedRulesByLine.get(line);
    if (kept !== undefined) return kept;
    return rulesByDisableLine.get(line) ?? [];
  };

  // Enables: an unused `eslint-enable` (no matching disable) is removed whole, and
  // a still-paired enable loses any rule its pruned disable no longer suppresses —
  // so one apply converges and a re-run is a no-op. Rule lists stay config-scoped;
  // a bare enable names no rules and is pruned structurally.
  for (const directive of directives) {
    if (directive.kind !== "enable") continue;
    const group = enableGroups.get(directive.line);
    const closed = directive.closes ?? [];
    const surviving = closed.filter((line) => !deletedDisableLines.has(line));
    const stranded = closed.length > 0 && surviving.length === 0;

    const survivingRules = new Set<string>();
    for (const line of surviving) for (const rule of postRulesForLine(line)) survivingRules.add(rule);

    // Rules pruned from a disable this enable closes that no surviving closed
    // disable still suppresses: the enable's re-enable of them is now unmatched.
    const editRemoved = new Set<string>();
    for (const line of closed) {
      for (const rule of removedByDisableLine.get(line) ?? []) {
        if (!survivingRules.has(rule)) editRemoved.add(rule);
      }
    }

    if (group === undefined && !stranded && editRemoved.size === 0) continue;

    if (stranded) {
      // Every disable it closed is gone: the enable re-enables nothing, so it is
      // removed whole and no orphan is left for a second pass.
      deletedEnables.set(directive.index, { directive, removed: [...directive.rules] });
      continue;
    }
    if (directive.rules.length === 0) {
      // A bare enable names no rules: prune it whole when ESLint flagged it unused.
      deletedEnables.set(directive.index, { directive, removed: [] });
      continue;
    }

    const unmatched = new Set<string>();
    if (group !== undefined) {
      if (group.whole) for (const rule of directive.rules) unmatched.add(rule);
      else for (const rule of group.rules) unmatched.add(rule);
    }
    for (const rule of editRemoved) if (directive.rules.includes(rule)) unmatched.add(rule);

    const removed = directive.rules.filter((rule) => unmatched.has(rule) && configRules.has(rule));
    if (removed.length === 0) continue;
    const keep = directive.rules.filter((rule) => !removed.includes(rule));
    if (keep.length === 0) deletedEnables.set(directive.index, { directive, removed });
    else strippedEnables.set(directive.index, { directive, keep, removed });
  }

  const crOf = (directive: ScannedDirective): string => (directive.cr ? "\r" : "");
  const deleteEdit = (
    directive: ScannedDirective,
    removed: string[],
    form: DirectiveForm,
  ): CleanupEdit => ({
    kind: "delete",
    index: directive.index,
    line: directive.line,
    form,
    removed,
    before: directive.text + crOf(directive),
    // A suffix directive keeps the code it rides on; only the comment is deleted.
    ...(directive.suffix ? { after: `${directive.code}${crOf(directive)}` } : {}),
  });

  const edits: CleanupEdit[] = [];
  for (const { directive, keep, removed } of stripped.values()) {
    edits.push({
      kind: "rewrite",
      index: directive.index,
      line: directive.line,
      form: directive.form,
      removed,
      before: directive.text + crOf(directive),
      after: formatDirective(directive, keep),
    });
  }
  for (const { directive, removed } of deletedDisables.values()) {
    edits.push(deleteEdit(directive, removed, directive.form));
  }
  for (const { directive, keep, removed } of strippedEnables.values()) {
    edits.push({
      kind: "rewrite",
      index: directive.index,
      line: directive.line,
      form: directive.form,
      removed,
      before: directive.text + crOf(directive),
      after: formatDirective(directive, keep),
    });
  }
  for (const { directive, removed } of deletedEnables.values()) {
    edits.push(deleteEdit(directive, removed, directive.form));
  }
  edits.sort((a, b) => a.index - b.index);

  // Every removal is ledgered (spec §6.5/§13). A bare comment names no rule, so
  // its deletion records the `*` sentinel — the whole rule set — keeping the
  // `(edit, rule)` grain exact without inventing a rule name.
  const records: EditRecord[] = [];
  for (const edit of edits) {
    const rules = edit.removed.length > 0 ? edit.removed : ["*"];
    for (const rule of rules) {
      records.push({
        file: options.filePath,
        line: edit.line,
        rule,
        editType: "prune",
        form: edit.form,
        before: edit.before,
        ...(edit.after === undefined ? {} : { after: edit.after }),
      });
    }
  }

  const ordered = [...edits].sort((a, b) => b.index - a.index);
  for (const edit of ordered) {
    if (edit.after === undefined) lines.splice(edit.index, 1);
    else lines[edit.index] = edit.after;
  }

  // Bare directives cleanup could not scope: they stay and are reported (a bare
  // guard names no rules, so it is never deleted unless ESLint flagged it whole).
  const notActionable: NotActionableDirective[] = [];
  for (const directive of directives) {
    if (directive.kind !== "disable" || !directive.bare) continue;
    if (deletedDisables.has(directive.index)) continue;
    notActionable.push({
      file: options.filePath,
      line: directive.line,
      form: directive.form,
      reason: "bare",
      text: directive.text,
    });
  }

  let rulesRemoved = 0;
  for (const entry of stripped.values()) rulesRemoved += entry.removed.length;
  for (const entry of deletedDisables.values()) rulesRemoved += entry.removed.length;
  for (const entry of strippedEnables.values()) rulesRemoved += entry.removed.length;
  for (const entry of deletedEnables.values()) rulesRemoved += entry.removed.length;

  return {
    output: edits.length === 0 ? options.text : lines.join("\n"),
    edits: records,
    notActionable,
    stats: {
      stripped: stripped.size + strippedEnables.size,
      deleted: deletedDisables.size + deletedEnables.size,
      skippedBare: notActionable.length,
      rulesRemoved,
    },
  };
}

/**
 * The action strategies, keyed by action. Ticket 05 lands `suppress`; ticket 09
 * adds `remove`; ticket 11 adds `cleanup`; later tickets add the rest. Actions
 * without a strategy run `lint-only`, so the pool, worker and UI can still
 * complete a run without inventing behaviour the spec has not pinned yet.
 */
const STRATEGIES: Partial<Record<Action, Strategy>> = {
  suppress: suppressStrategy,
  remove: removeStrategy,
  cleanup: cleanupStrategy,
};

/**
 * Plan (and, when `apply`, apply) one file's action. Returns the new text plus
 * the ledger's edits and counters.
 */
export function runActionForFile(options: RunActionForFileOptions): RunActionResult {
  const strategy = STRATEGIES[options.action] ?? lintOnly;
  return strategy(options);
}

/** Placeholder for actions without a strategy yet: no edits, a message tally. */
function lintOnly(options: RunActionForFileOptions): RunActionResult {
  let errors = 0;
  let warnings = 0;
  for (const message of options.messages) {
    if (message.severity === 2) errors += 1;
    else warnings += 1;
  }
  return {
    output: options.text,
    edits: [],
    stats: { messages: options.messages.length, errors, warnings },
  };
}

export interface RunBatchOptions {
  action: Action;
  params: StrategyParams;
  mode: RunMode;
}

export interface RunBatchResult {
  outcomes: BatchOutcome[];
  dropped: DroppedFile[];
  fatal: FatalFile[];
}

/**
 * The shared hot path, used by the worker thread, the serial run, and the
 * main-thread recovery of a crashed worker's chunk alike: lint one batch
 * against the caller's persistent instance, run the action strategy per file,
 * and let the producing process own the write (spec §7). Keeping this in one
 * place means all three callers produce byte-identical outcomes.
 */
export async function runBatch(
  eslint: ESLint,
  files: string[],
  options: RunBatchOptions,
): Promise<RunBatchResult> {
  const { results, dropped, fatal } = await lintFiles(eslint, files);

  const outcomes: BatchOutcome[] = [];
  for (const result of results) {
    const text = readFileSync(result.filePath, "utf8");
    const planned = runActionForFile({
      action: options.action,
      params: options.params,
      filePath: result.filePath,
      text,
      messages: result.messages,
      apply: options.mode === "apply",
    });

    const changed = planned.output !== text;
    if (changed && options.mode === "apply") {
      writeFileSync(result.filePath, planned.output);
    }

    outcomes.push({
      filePath: result.filePath,
      messages: result.messages,
      edits: planned.edits,
      changed,
      // The planned text only travels back on a dry run; on apply it is on disk.
      ...(changed && options.mode === "dry-run" ? { output: planned.output } : {}),
      stats: planned.stats,
      ...(planned.notActionable === undefined ? {} : { notActionable: planned.notActionable }),
    });
  }

  return { outcomes, dropped, fatal };
}
