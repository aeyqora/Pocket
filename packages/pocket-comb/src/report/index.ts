import { writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { renderCsv } from "./csv.js";
import { renderHtml } from "./html.js";
import { renderJson } from "./json.js";
import type { ReportSetting } from "../config.js";
import type { FileCount, RunMeta, RunReport } from "../ledger.js";
import type { DirectiveForm, ReportFormat } from "../types.js";

export { renderCsv } from "./csv.js";
export { renderHtml } from "./html.js";
export { renderJson } from "./json.js";

/**
 * One census total: how many directives of a `form` name a `rule`. A bare
 * directive carries no rule list, so it is counted per form with `rule: null`
 * (spec §6.6).
 */
export interface CensusTotal {
  form: DirectiveForm;
  /** The rule token, or `null` for a bare directive (counted per form). */
  rule: string | null;
  count: number;
}

/**
 * The `inventory` census (spec §6.6, §13). **Ticket 12 owns this shape**; ticket
 * 07 renders it. The renderers depend only on `meta`, `totals` and `byFile`, so
 * ticket 12 may widen this additively without touching the reporters.
 *
 * Ordering is the stable-census contract: `totals` by form (canonical order) then
 * rule alphabetical with bare (`null`) last; `byFile` by path.
 */
export interface CensusReport {
  meta: RunMeta;
  totals: CensusTotal[];
  byFile: FileCount[];
}

/**
 * The report the renderers consume: a run report (edits + rollups) or a census
 * (totals + per-file counts). Discriminated structurally — `totals` (census) vs
 * `edits` (run) — so the architecture-notes `RunReport | CensusReport` signature
 * holds without a wrapper type.
 */
export type ReportData = RunReport | CensusReport;

/** True when `data` is the `inventory` census rather than a run report. */
export function isCensusReport(data: ReportData): data is CensusReport {
  return "totals" in data;
}

/** The stable default report basename; the extension is chosen per format. */
export const DEFAULT_REPORT_BASENAME = "pocket-comb-report";

const REPORT_EXTENSIONS: Record<ReportFormat, string> = {
  csv: "csv",
  json: "json",
  html: "html",
};

/** The default destination for a format: `pocket-comb-report.<ext>` in `cwd`. */
export function defaultReportPath(cwd: string, format: ReportFormat): string {
  return join(cwd, `${DEFAULT_REPORT_BASENAME}.${REPORT_EXTENSIONS[format]}`);
}

/** What the run carried on the CLI and in `settings["pocket-comb"].report`. */
export interface ReportOptionsInput {
  formatFlag?: ReportFormat | null;
  outFlag?: string | null;
  noReport?: boolean;
  /** The config's `report` setting (already flag-or-settings merged by `loadConfig`). */
  setting?: ReportSetting;
  cwd: string;
}

export interface ResolvedReportOptions {
  /** False when `--no-report` asked for no report at all. */
  enabled: boolean;
  format: ReportFormat;
  /** An absolute file path, or `"-"` for stdout (spec §4, §13). */
  out: string;
}

/**
 * Resolve the report format and destination, precedence
 * **flag > settings key > default** (spec §3): default format `html`, default
 * destination `pocket-comb-report.<ext>` in the cwd. A relative `--out` (or a
 * relative `settings.report.out`) resolves against the cwd; `-` means stdout.
 */
export function resolveReportOptions(input: ReportOptionsInput): ResolvedReportOptions {
  const format = input.formatFlag ?? input.setting?.format ?? "html";
  const requested = input.outFlag ?? input.setting?.out ?? null;
  let out: string;
  if (requested === null) out = defaultReportPath(input.cwd, format);
  else if (requested === "-") out = "-";
  else out = isAbsolute(requested) ? requested : resolve(input.cwd, requested);
  return { enabled: input.noReport !== true, format, out };
}

/** Render one report in the requested format. */
export function renderReport(data: ReportData, format: ReportFormat): string {
  switch (format) {
    case "csv":
      return renderCsv(data);
    case "json":
      return renderJson(data);
    case "html":
      return renderHtml(data);
  }
}

export interface EmitReportOptions {
  data: ReportData;
  format: ReportFormat;
  /** An absolute file path, or `"-"` for stdout. */
  out: string;
  /** Where `--out -` writes; stdout, so a piped census stays parseable. */
  stdout: NodeJS.WritableStream;
}

export interface EmitReportResult {
  /** The path written, or `null` when the report went to stdout. */
  path: string | null;
}

/**
 * Render and write one report. A file destination is clobbered per run (the
 * stable-name contract, spec §13); `-` streams to the injected stdout and never
 * touches the filesystem.
 */
export function emitReport(options: EmitReportOptions): EmitReportResult {
  const content = renderReport(options.data, options.format);
  if (options.out === "-") {
    options.stdout.write(content);
    return { path: null };
  }
  writeFileSync(options.out, content);
  return { path: options.out };
}
