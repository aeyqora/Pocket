import type { ReportData } from "./index.js";

/**
 * The canonical JSON schema (spec §13): the `RunReport` (metadata + edit ledger +
 * rollups) or the `CensusReport` (metadata + totals + per-file counts), verbatim.
 * The other two formats are projections of exactly this.
 *
 * `pretty` defaults to true: a report file is a document first and a machine
 * payload second. The output is always newline-terminated.
 */
export function renderJson(report: ReportData, pretty = true): string {
  return `${JSON.stringify(report, null, pretty ? 2 : undefined)}\n`;
}
