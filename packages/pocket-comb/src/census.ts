/**
 * The inventory census (spec §6.6, §13): a read-only count of **every**
 * suppression directive in the target, over all four forms, decomposed per
 * `(form, rule)` and per file. It is the tool's fastest action because it never
 * lints — it walks the discovered files, scans each one's text with the shared
 * full-file scan (`scan.ts`), and tallies.
 *
 * Two grains, deliberately:
 *
 * - `totals` counts **rule incidences** — "how many directives of a form name a
 *   rule" (ticket 07's `CensusTotal`). A directive that names N rules is counted
 *   once for each; a bare directive names no rule and is counted once per form
 *   with `rule: null`. This is the per-rule view of suppression debt.
 * - `byFile` counts **directives** — each disable directive once, whatever its
 *   rule list. This is the per-file view.
 *
 * An `eslint-enable` is a block closer, not a suppression, so it is excluded.
 *
 * Ordering is the stable-census contract (spec §6.6) so successive censuses diff
 * cleanly: totals by form (canonical order) then rule alphabetical with bare
 * (`null`) last; per-file counts by path. The builder sorts, so its output is
 * independent of the discovery order.
 */
import { DIRECTIVE_FORMS, type FileCount, type FormCount } from "./ledger.js";
import { scanDirectives, type ScannedDirective } from "./scan.js";
import type { CensusTotal } from "./report/index.js";
import type { DirectiveForm } from "./types.js";

/** One counted census entry: a directive's form plus a rule it names, or null. */
export interface CensusEntry {
  form: DirectiveForm;
  rule: string | null;
}

/** One file's text, as the census consumes it (paths are absolute). */
export interface CensusInput {
  file: string;
  text: string;
}

/** One file's scan: its disable directives, and the entries they yield. */
export interface CensusFileScan {
  /** Disable directives in the file (enables excluded; each counted once). */
  disables: ScannedDirective[];
  /** One entry per named rule; a bare directive yields one `rule: null` entry. */
  entries: CensusEntry[];
}

export interface CensusResult {
  /** `(form, rule)` totals, stable: form canonical order, rule alphabetical, bare last. */
  totals: CensusTotal[];
  /** Per-file directive counts, ordered by path; files with no directives are omitted. */
  byFile: FileCount[];
  /** Per-form directive counts (canonical order), for the human summary. */
  byForm: FormCount[];
  /** Total disable directives across every file. */
  directives: number;
}

/**
 * Scan one file's lines for census entries: every disable directive, one entry
 * per rule it names (or one bare entry). Enables are excluded.
 */
export function censusFileScan(lines: readonly string[]): CensusFileScan {
  const disables: ScannedDirective[] = [];
  const entries: CensusEntry[] = [];
  for (const directive of scanDirectives(lines)) {
    if (directive.kind !== "disable") continue;
    disables.push(directive);
    if (directive.bare) {
      entries.push({ form: directive.form, rule: null });
      continue;
    }
    for (const rule of directive.rules) entries.push({ form: directive.form, rule });
  }
  return { disables, entries };
}

/** The rule-incidence entries of one file (the `totals` grain). */
export function censusEntries(lines: readonly string[]): CensusEntry[] {
  return censusFileScan(lines).entries;
}

const FORM_RANK = new Map<DirectiveForm, number>(
  DIRECTIVE_FORMS.map((form, index) => [form, index]),
);

/** Totals order: form (canonical) then rule alphabetical, with bare (`null`) last. */
function compareTotals(a: CensusTotal, b: CensusTotal): number {
  const formDiff = (FORM_RANK.get(a.form) ?? 0) - (FORM_RANK.get(b.form) ?? 0);
  if (formDiff !== 0) return formDiff;
  if (a.rule === null) return b.rule === null ? 0 : 1;
  if (b.rule === null) return -1;
  return a.rule.localeCompare(b.rule);
}

/** Aggregate the per-file scans into the canonical census result. */
export function censusFiles(files: readonly CensusInput[]): CensusResult {
  const totals = new Map<string, CensusTotal>();
  const byFile: FileCount[] = [];
  const formCounts = new Map<DirectiveForm, number>();
  let directives = 0;

  for (const { file, text } of files) {
    const scan = censusFileScan(text.split("\n"));
    if (scan.disables.length === 0) continue;
    directives += scan.disables.length;
    byFile.push({ file, count: scan.disables.length });
    for (const directive of scan.disables) {
      formCounts.set(directive.form, (formCounts.get(directive.form) ?? 0) + 1);
    }
    for (const entry of scan.entries) {
      const key = `${entry.form}\u0000${entry.rule ?? ""}`;
      const existing = totals.get(key);
      if (existing === undefined) totals.set(key, { form: entry.form, rule: entry.rule, count: 1 });
      else existing.count += 1;
    }
  }

  byFile.sort((a, b) => a.file.localeCompare(b.file));

  return {
    totals: [...totals.values()].sort(compareTotals),
    byFile,
    byForm: DIRECTIVE_FORMS.filter((form) => formCounts.has(form)).map((form) => ({
      form,
      count: formCounts.get(form)!,
    })),
    directives,
  };
}
