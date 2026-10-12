import { readFileSync, writeFileSync } from "node:fs";
import { lintFiles, type DroppedFile, type FatalFile } from "./eslint.js";
import type { ESLint } from "eslint";
import type {
  Action,
  BatchOutcome,
  DirectiveForm,
  EditRecord,
  JsonValue,
  LintMessage,
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

export interface RuleList {
  rules: string[];
  desc: string;
  bare: boolean;
}

/**
 * Split a directive's tail into its rule list and optional `-- description`
 * (spec §6.1): the description is whatever follows the first `--`, and the rule
 * list is the comma-separated tokens before it. `bare` means no rules listed.
 */
export function splitRuleList(rest: string): RuleList {
  let tail = rest;
  let desc = "";
  const separator = tail.indexOf("--");
  if (separator >= 0) {
    desc = tail.slice(separator + 2).trim();
    tail = tail.slice(0, separator);
  }
  const rules = tail
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return { rules, desc, bare: rules.length === 0 };
}

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
 * The action strategies, keyed by action. Ticket 05 lands `suppress`; later
 * tickets add the rest. Actions without a strategy run `lint-only`, so the pool,
 * worker and UI can still complete a run without inventing behaviour the spec
 * has not pinned yet.
 */
const STRATEGIES: Partial<Record<Action, Strategy>> = { suppress: suppressStrategy };

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
    });
  }

  return { outcomes, dropped, fatal };
}
