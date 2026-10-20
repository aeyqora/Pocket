import { relative } from "node:path";
import { EDIT_TYPES, type EditRecord, type EditType, type NotActionableDirective } from "./types.js";
import type { FormCount } from "./ledger.js";

/** What the spinner renders: the stage name plus a done/total count. */
export interface Progress {
  stage: string;
  done: number;
  total: number;
}

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface SpinnerOptions {
  /** Defaults to stderr so stdout stays clean for `--out -`. */
  output?: NodeJS.WritableStream;
  /** Defaults to the stream's `isTTY`; a non-TTY gets a silent spinner. */
  tty?: boolean;
  intervalMs?: number;
  frames?: readonly string[];
}

export interface Spinner {
  update(progress: Progress): void;
  stop(): void;
}

/**
 * The hand-rolled, main-thread spinner (spec §4). It only schedules a timer and
 * writes a redrawn line; all CPU work lives in the worker pool, so the event loop
 * (and therefore the animation) can never freeze on lint or apply. A non-TTY
 * stream gets a silent spinner: pipes must never carry frame noise.
 */
export function createSpinner(options: SpinnerOptions = {}): Spinner {
  const output = options.output ?? process.stderr;
  const tty = options.tty ?? (output as { isTTY?: boolean }).isTTY === true;
  if (!tty) return { update() {}, stop() {} };

  const frames = options.frames ?? DEFAULT_FRAMES;
  const intervalMs = options.intervalMs ?? 80;
  let frame = 0;
  let current: Progress = { stage: "starting", done: 0, total: 0 };

  const render = (): void => {
    output.write(`\r\u001b[2K${frames[frame]!} ${current.stage} ${current.done}/${current.total}`);
  };

  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    render();
  }, intervalMs);
  render();

  return {
    update(progress: Progress): void {
      current = progress;
      render();
    },
    stop(): void {
      clearInterval(timer);
      output.write("\r\u001b[2K");
    },
  };
}

/** The completion confirmation's numbers (spec §4). */
export interface CompletionSummary {
  filesTouched: number;
  edits: number;
  inserted: number;
  prepended: number;
  /** Autofix edits (`fix` action / `--fix-first`); the slot appears only when > 0. */
  fixed?: number;
  elapsedMs: number;
}

/**
 * The completion confirmation, exact shape from spec §4:
 * `Done: 37 files touched, 214 edits (152 inserted, 62 prepended) — 8.4s`.
 * Autofix runs add a `, N fixed` slot so the fix phase is visible.
 */
export function formatCompletion(summary: CompletionSummary): string {
  const fixed = summary.fixed ?? 0;
  const fixSlot = fixed > 0 ? `, ${fixed} fixed` : "";
  return (
    `Done: ${summary.filesTouched} files touched, ${summary.edits} edits ` +
    `(${summary.inserted} inserted, ${summary.prepended} prepended${fixSlot}) — ` +
    `${(summary.elapsedMs / 1000).toFixed(1)}s`
  );
}

/** Roll the per-file outcomes into the completion summary. */
export function summarizeRun(
  outcomes: ReadonlyArray<{ changed: boolean; edits: readonly EditRecord[] }>,
  elapsedMs: number,
): CompletionSummary {
  let filesTouched = 0;
  let edits = 0;
  let inserted = 0;
  let prepended = 0;
  let fixed = 0;

  for (const outcome of outcomes) {
    if (outcome.changed) filesTouched += 1;
    edits += outcome.edits.length;
    for (const edit of outcome.edits) {
      if (edit.editType === "insert") inserted += 1;
      else if (edit.editType === "prepend") prepended += 1;
      else if (edit.editType === "fix") fixed += 1;
    }
  }

  return { filesTouched, edits, inserted, prepended, fixed, elapsedMs };
}

/** Print the completion confirmation, newline-terminated. */
export function writeCompletion(
  output: NodeJS.WritableStream,
  summary: CompletionSummary,
): void {
  output.write(`${formatCompletion(summary)}\n`);
}

/**
 * The `inventory` run's human line (spec §6.6): a read-only census has no edits
 * and no impact, so it reports what it counted instead of the mutating
 * completion line. `files` is the number of files scanned; `directives` the
 * number of disable directives found; `byForm` breaks those directives down per
 * form.
 */
export interface CensusSummary {
  files: number;
  directives: number;
  byForm: FormCount[];
  elapsedMs: number;
}

/** The census completion line: `Census: 3 directives in 2 files (next-line 2, line 1) — 0.1s`. */
export function formatCensusSummary(summary: CensusSummary): string {
  const byForm =
    summary.byForm.length === 0
      ? "none"
      : summary.byForm.map((entry) => `${entry.form} ${entry.count}`).join(", ");
  return (
    `Census: ${summary.directives} directives in ${summary.files} files ` +
    `(${byForm}) — ${(summary.elapsedMs / 1000).toFixed(1)}s`
  );
}

/** Print the census completion line, newline-terminated. */
export function writeCensusSummary(
  output: NodeJS.WritableStream,
  summary: CensusSummary,
): void {
  output.write(`${formatCensusSummary(summary)}\n`);
}

/** One `by type` entry: an edit kind and how many ledger records it produced. */
export interface ImpactTypeCount {
  editType: EditType;
  count: number;
}

/** One `by rule` entry: a rule and how many ledger records name it. */
export interface ImpactRuleCount {
  rule: string;
  count: number;
}

/**
 * The dry-run/apply impact answer (spec §13): files would-change, edits by type
 * and rule. Grain matches the ledger — one count per `(edit, rule)` record — so
 * the numbers agree with the completion line and the report's rollups.
 */
export interface ImpactSummary {
  filesTouched: number;
  edits: number;
  inserted: number;
  prepended: number;
  /** Autofix edits; the slot appears only when > 0. */
  fixed?: number;
  byType: ImpactTypeCount[];
  byRule: ImpactRuleCount[];
}

/** Roll per-file outcomes into the impact summary, stable ordering throughout. */
export function summarizeImpact(
  outcomes: ReadonlyArray<{ changed: boolean; edits: readonly EditRecord[] }>,
): ImpactSummary {
  let filesTouched = 0;
  let edits = 0;
  let inserted = 0;
  let prepended = 0;
  let fixed = 0;
  const typeCounts = new Map<EditType, number>();
  const ruleCounts = new Map<string, number>();

  for (const outcome of outcomes) {
    if (outcome.changed) filesTouched += 1;
    for (const edit of outcome.edits) {
      edits += 1;
      if (edit.editType === "insert") inserted += 1;
      else if (edit.editType === "prepend") prepended += 1;
      else if (edit.editType === "fix") fixed += 1;
      typeCounts.set(edit.editType, (typeCounts.get(edit.editType) ?? 0) + 1);
      ruleCounts.set(edit.rule, (ruleCounts.get(edit.rule) ?? 0) + 1);
    }
  }

  return {
    filesTouched,
    edits,
    inserted,
    prepended,
    fixed,
    byType: EDIT_TYPES.filter((type) => typeCounts.has(type)).map((type) => ({
      editType: type,
      count: typeCounts.get(type)!,
    })),
    byRule: [...ruleCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([rule, count]) => ({ rule, count })),
  };
}

/**
 * The impact summary, printed before any report (spec §13). Three lines: the
 * headline counts, then edits by type and by rule. A dry run says `would
 * change`; an apply run says `changed`. Autofix runs add a `, N fixed` slot.
 */
export function formatImpactSummary(summary: ImpactSummary, dryRun: boolean): string {
  const verb = dryRun ? "would change" : "changed";
  const fixed = summary.fixed ?? 0;
  const fixSlot = fixed > 0 ? `, ${fixed} fixed` : "";
  const byType =
    summary.byType.length === 0
      ? "none"
      : summary.byType.map((entry) => `${entry.editType} ${entry.count}`).join(", ");
  const byRule =
    summary.byRule.length === 0
      ? "none"
      : summary.byRule.map((entry) => `${entry.rule} ${entry.count}`).join(", ");
  return (
    `Impact: ${summary.filesTouched} files ${verb}, ${summary.edits} edits ` +
    `(${summary.inserted} inserted, ${summary.prepended} prepended${fixSlot})\n` +
    `  by type: ${byType}\n` +
    `  by rule: ${byRule}`
  );
}

/** Print the impact summary, newline-terminated. */
export function writeImpactSummary(
  output: NodeJS.WritableStream,
  summary: ImpactSummary,
  dryRun: boolean,
): void {
  output.write(`${formatImpactSummary(summary, dryRun)}\n`);
}

/**
 * List the directives an action recognised but could not act on (spec §6.1,
 * §6.3, §6.5): a bare guard names no rules, so it cannot be scoped — remove and
 * cleanup leave it, and suppress will not rewrite it. Stable order: file, then
 * line. Shared by every action that can surface one.
 */
export function writeNotActionable(
  output: NodeJS.WritableStream,
  cwd: string,
  outcomes: ReadonlyArray<{ notActionable?: NotActionableDirective[] }>,
): void {
  const notes = outcomes
    .flatMap((outcome) => outcome.notActionable ?? [])
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  if (notes.length === 0) return;

  output.write(`Not actionable: ${notes.length} bare directives (no rule list)\n`);
  for (const note of notes) {
    output.write(`  ${relative(cwd, note.file)}:${note.line} ${note.form} ${note.text}\n`);
  }
}
