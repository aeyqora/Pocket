import { isCensusReport, type ReportData } from "./index.js";

/** The flat-ledger columns (spec §13). */
const RUN_HEADER = ["file", "line", "rule", "editType", "form", "before", "after"] as const;

/** The census's flat table: one row per `(form, rule)` total (spec §6.6). */
const CENSUS_HEADER = ["form", "rule", "count"] as const;

/**
 * RFC-4180 field quoting: a field containing a comma, a double-quote, CR or LF is
 * wrapped in double-quotes and any inner double-quote is doubled. Everything else
 * is emitted bare. Records are LF-terminated (the tool's own convention; the
 * quoting rules are what RFC-4180 pins).
 */
function quote(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

function row(fields: ReadonlyArray<string | number | null | undefined>): string {
  return fields.map((field) => quote(field === null || field === undefined ? "" : String(field))).join(",");
}

/**
 * CSV: the flat ledger — a header row then one row per edit (or, for the census,
 * one row per `(form, rule)` total). A bare directive's rule is an empty field.
 */
export function renderCsv(report: ReportData): string {
  const lines: string[] = [];
  if (isCensusReport(report)) {
    lines.push(row(CENSUS_HEADER));
    for (const total of report.totals) lines.push(row([total.form, total.rule, total.count]));
  } else {
    lines.push(row(RUN_HEADER));
    for (const edit of report.edits) {
      lines.push(
        row([edit.file, edit.line, edit.rule, edit.editType, edit.form, edit.before, edit.after]),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
