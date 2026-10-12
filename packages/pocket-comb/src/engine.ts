import { readFileSync, writeFileSync } from "node:fs";
import { ESLint } from "eslint";
import { lintFiles, type DroppedFile, type FatalFile } from "./eslint.js";
import { formatDirective, scanDirectives, splitRuleList } from "./scan.js";
import type { ScannedDirective } from "./scan.js";
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

// `splitRuleList` and `RuleList` live in `scan.ts` (the shared full-file scan)
// so the engine can import them without a cycle; re-exported here to keep the
// public surface stable.
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

// --- enclosing block/file-level guard (--reuse-blocks) ------------------------

/** An enclosing `block`-open or `file-level` directive (spec §6.1). */
export interface BlockGuard {
  /** 0-based index of the directive line. */
  index: number;
  /** 1-based line of the directive (the ledger anchor). */
  line: number;
  indent: string;
  /** The comment opener, `//` or `/*`. */
  open: string;
  rules: string[];
  desc: string;
  bare: boolean;
  cr: boolean;
  /** `block` when an `eslint-enable` follows, else `file-level`. */
  form: "block" | "file-level";
}

/**
 * The enclosing-guard finder for `--reuse-blocks` (spec §6.1/§7): the nearest
 * `eslint-disable` that still covers the violation — a `block`-open whose paired
 * `eslint-enable` sits below the violation, or a `file-level` directive above
 * it. Built on the shared full-file scan (`scanDirectives`), so it reuses the
 * one directive grammar and the same block pairing as remove/replace/inventory.
 * The selection walks the directives once and keeps the closest enclosing line.
 */
export function findEnclosingBlockGuard(
  lines: readonly string[],
  violationLine: number,
): BlockGuard | undefined {
  let best: ScannedDirective | undefined;
  for (const directive of scanDirectives(lines)) {
    if (directive.kind !== "disable") continue;
    if (directive.form !== "block" && directive.form !== "file-level") continue;
    if (directive.line >= violationLine) continue;
    if (
      directive.form === "block" &&
      (directive.pairLine === undefined || directive.pairLine <= violationLine)
    ) {
      continue;
    }
    if (best === undefined || directive.line > best.line) best = directive;
  }
  if (best === undefined) return undefined;
  return {
    index: best.index,
    line: best.line,
    indent: best.indent,
    open: best.comment,
    rules: best.rules,
    desc: best.description,
    bare: best.bare,
    cr: best.cr,
    form: best.form === "block" ? "block" : "file-level",
  };
}

export type SuppressEditKind = "insert" | "prepend-line" | "prepend-next" | "prepend-block";

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
 * With `--reuse-blocks` and the file's `lines` supplied, a violation with no
 * line-local guard is checked against the enclosing `block`-open / `file-level`
 * directive (a bounded upward scan, `findEnclosingBlockGuard`) and its rule is
 * prepended there instead. Without the flag — or with no enclosing guard — the
 * default minimal-span insert applies, whether or not the line sits in a span.
 */
export function planSuppressEdits(
  targets: readonly SuppressTarget[],
  params: SuppressParams,
  lines?: readonly string[],
): SuppressPlan {
  const reason = params.reason ? ` -- ${params.reason}` : "";
  const reuseBlocks = params.reuseBlocks === true && lines !== undefined;
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

    // No line-local guard. With `--reuse-blocks`, look for an enclosing
    // block-open / file-level directive and prepend there instead (spec §6.1).
    if (reuseBlocks) {
      const block = findEnclosingBlockGuard(lines!, target.line);
      if (block !== undefined) {
        if (block.bare) {
          skippedBare += 1;
          continue;
        }
        const missing = target.rules.filter((rule) => !block.rules.includes(rule));
        if (missing.length === 0) {
          skippedGuarded += 1;
          continue;
        }
        const all = [...missing, ...block.rules];
        const desc = block.desc ? ` -- ${block.desc}` : "";
        const cr = block.cr ? "\r" : "";
        const close = block.open === "/*" ? " */" : "";
        edits.push({
          kind: "prepend-block",
          line: block.line,
          index: block.index,
          added: missing,
          before: lines![block.index] ?? "",
          after: `${block.indent}${block.open} eslint-disable ${all.join(", ")}${desc}${close}${cr}`,
          form: block.form,
        });
        continue;
      }
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
  const { edits, skippedBare, skippedGuarded } = planSuppressEdits(
    targets,
    params,
    params.reuseBlocks === true ? lines : undefined,
  );

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
 * The action strategies, keyed by action. Ticket 05 lands `suppress`; ticket 09
 * adds `remove`; later tickets add the rest. Actions without a strategy run
 * `lint-only`, so the pool, worker and UI can still complete a run without
 * inventing behaviour the spec has not pinned yet.
 */
const STRATEGIES: Partial<Record<Action, Strategy>> = {
  suppress: suppressStrategy,
  remove: removeStrategy,
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
  /**
   * Ticket 08, `suppress --fix-first`: run the fix phase first (writes via
   * `outputFixes` on apply), re-lint the fixed files, then suppress the
   * remainder — all in one batch.
   */
  fixFirst?: boolean;
  /**
   * Ticket 08: the fix-enabled instance for the fix phase. Required whenever
   * `fixFirst` is set; ignored otherwise (the `fix` action's own instance is
   * already fix-enabled).
   */
  fixEslint?: ESLint;
}

export interface RunBatchResult {
  outcomes: BatchOutcome[];
  dropped: DroppedFile[];
  fatal: FatalFile[];
}

/** One `fix` ledger record for a file whose autofix changed the text. */
function fixRecord(file: string): EditRecord {
  // Autofix has no single anchoring rule/line: one record per changed file keeps
  // the completion's "files fixed" count honest (spec §13's `fix` edit type).
  return { file, line: 1, rule: "(autofix)", editType: "fix", form: null };
}

/**
 * The `fix` action's batch (spec §6.2): one `lintFiles` call on the fix-enabled
 * instance, then — on apply — a single `ESLint.outputFixes` write. Dry run ships
 * the planned `output` back and never writes. ESLint converges internally (the
 * 10-pass cap with circular-fix detection); the tool never loops.
 */
async function runFixBatch(
  eslint: ESLint,
  files: string[],
  options: RunBatchOptions,
): Promise<RunBatchResult> {
  const { results, dropped, fatal } = await lintFiles(eslint, files);
  if (options.mode === "apply" && results.length > 0) {
    await ESLint.outputFixes(results);
  }

  const outcomes: BatchOutcome[] = results.map((result) => {
    const changed = result.output !== undefined;
    return {
      filePath: result.filePath,
      messages: result.messages,
      edits: changed ? [fixRecord(result.filePath)] : [],
      changed,
      ...(changed && options.mode === "dry-run" ? { output: result.output } : {}),
      stats: {
        wouldFix: changed ? 1 : 0,
        fixed: changed ? 1 : 0,
        fixableErrors: result.fixableErrorCount,
        fixableWarnings: result.fixableWarningCount,
      },
    };
  });

  return { outcomes, dropped, fatal };
}

/**
 * `suppress --fix-first` (spec §6.1): fix first, then suppress only the
 * remainder, in one batch. On apply the fix phase writes via `outputFixes`, so
 * the re-lint genuinely re-reads the fixed files from disk. On a dry run the
 * fix phase never writes; the fix pass's messages already describe the fixed
 * text, so the suppress phase runs against the planned `output` in memory.
 */
async function runFixFirstBatch(
  eslint: ESLint,
  fixEslint: ESLint,
  files: string[],
  options: RunBatchOptions,
): Promise<RunBatchResult> {
  const fixPass = await lintFiles(fixEslint, files);
  if (options.mode === "apply" && fixPass.results.length > 0) {
    await ESLint.outputFixes(fixPass.results);
  }

  // The suppress phase's inputs: on apply, a fresh lint re-reads the written
  // files from disk; on a dry run, the fix pass's results already hold the
  // post-fix text (`output`) and messages.
  const suppress = options.mode === "apply" ? await lintFiles(eslint, files) : fixPass;
  const fixedFiles = new Set<string>();
  for (const result of fixPass.results) {
    if (result.output !== undefined) fixedFiles.add(result.filePath);
  }

  const outcomes: BatchOutcome[] = [];
  for (const result of suppress.results) {
    const onDisk = readFileSync(result.filePath, "utf8");
    const baseText =
      options.mode === "dry-run" && result.output !== undefined ? result.output : onDisk;
    const planned = runActionForFile({
      action: "suppress",
      params: options.params,
      filePath: result.filePath,
      text: baseText,
      messages: result.messages,
      apply: options.mode === "apply",
    });

    const suppressChanged = planned.output !== baseText;
    const changed = fixedFiles.has(result.filePath) || suppressChanged;
    if (suppressChanged && options.mode === "apply") {
      writeFileSync(result.filePath, planned.output);
    }

    const edits = [
      ...(changed && fixedFiles.has(result.filePath) ? [fixRecord(result.filePath)] : []),
      ...planned.edits,
    ];
    outcomes.push({
      filePath: result.filePath,
      messages: result.messages,
      edits,
      changed,
      ...(changed && options.mode === "dry-run" ? { output: planned.output } : {}),
      stats: { ...planned.stats, fixed: fixedFiles.has(result.filePath) ? 1 : 0 },
    });
  }

  return { outcomes, dropped: suppress.dropped, fatal: suppress.fatal };
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
  if (options.action === "fix") {
    return runFixBatch(eslint, files, options);
  }
  if (options.action === "suppress" && options.fixFirst === true && options.fixEslint !== undefined) {
    return runFixFirstBatch(eslint, options.fixEslint, files, options);
  }

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
