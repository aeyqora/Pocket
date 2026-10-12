/**
 * The edit ledger and run record (spec §13, architecture notes `ledger.ts`).
 *
 * `EditRecord` itself lives in `types.ts` because `BatchOutcome` needs it and the
 * worker pool predates this module. Everything here rolls those records up into
 * the canonical `RunReport` the reporters (ticket 07) render.
 *
 * Grain: one `EditRecord` per `(edit, rule)`. A suppress edit aggregates a whole
 * line's rules into one directive (spec §6.1), but the record's `rule` is
 * singular and `byRule` must be exact, so an edit that touches N rules emits N
 * records that share its `line`/`editType`/`form`/`before`/`after`.
 */
import type { Action, DirectiveForm, EditRecord } from "./types.js";

/**
 * Canonical directive-form order, used to sort `byForm` so successive reports
 * diff cleanly (spec §6.6's stable-ordering rationale).
 */
export const DIRECTIVE_FORMS: readonly DirectiveForm[] = [
  "next-line",
  "line",
  "block",
  "file-level",
];

/** Run metadata (spec §13): version, action, config identity, target, counts. */
export interface RunMeta {
  tool: "pocket-comb";
  version: string;
  action: Action;
  /** Absolute action-config path. */
  configPath: string;
  /** sha256 hex of the config file bytes. */
  configHash: string;
  /** Absolute resolved target root. */
  target: string;
  /** ISO-8601 timestamp the run began. */
  startedAt: string;
  durationMs: number;
  dryRun: boolean;
  workers: number;
  counts: {
    discovered: number;
    linted: number;
    dropped: number;
    touched: number;
  };
}

export interface RuleCount {
  rule: string;
  count: number;
}

export interface FormCount {
  form: DirectiveForm;
  count: number;
}

export interface FileCount {
  file: string;
  count: number;
}

/** The canonical run report (spec §13): metadata + ledger + rollups. */
export interface RunReport {
  meta: RunMeta;
  edits: EditRecord[];
  byRule: RuleCount[];
  byForm: FormCount[];
  byFile: FileCount[];
}

function tally(values: Iterable<string>, compare: (a: string, b: string) => number): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => compare(a[0], b[0]));
}

/** Rules touched, alphabetical (spec §6.6; stable across censuses). */
export function rollupByRule(edits: readonly EditRecord[]): RuleCount[] {
  return tally(
    edits.map((edit) => edit.rule),
    (a, b) => a.localeCompare(b),
  ).map(([rule, count]) => ({ rule, count }));
}

/** Edits per directive form, in canonical form order. Null forms are skipped. */
export function rollupByForm(edits: readonly EditRecord[]): FormCount[] {
  const counts = new Map<DirectiveForm, number>();
  for (const edit of edits) {
    if (edit.form === null) continue;
    counts.set(edit.form, (counts.get(edit.form) ?? 0) + 1);
  }
  return DIRECTIVE_FORMS.filter((form) => counts.has(form)).map((form) => ({
    form,
    count: counts.get(form)!,
  }));
}

/** Edits per file, ordered by path (spec §13). */
export function rollupByFile(edits: readonly EditRecord[]): FileCount[] {
  return tally(
    edits.map((edit) => edit.file),
    (a, b) => a.localeCompare(b),
  ).map(([file, count]) => ({ file, count }));
}

/** Assemble the canonical report from metadata and the merged ledger. */
export function buildRunReport(meta: RunMeta, edits: readonly EditRecord[]): RunReport {
  const ledger = [...edits];
  return {
    meta,
    edits: ledger,
    byRule: rollupByRule(ledger),
    byForm: rollupByForm(ledger),
    byFile: rollupByFile(ledger),
  };
}
