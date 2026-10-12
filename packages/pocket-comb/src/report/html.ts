import { isCensusReport, type CensusReport, type ReportData } from "./index.js";
import type { FileCount, RunMeta, RunReport } from "../ledger.js";

/**
 * HTML escaping for both text and attribute contexts. Everything that reaches the
 * page — file paths, rule names, directive text — is user-controlled, so nothing
 * is interpolated raw.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function table(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = rows
    .map((cells) => `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function details(summary: string, body: string): string {
  return `<details><summary>${escapeHtml(summary)}</summary>${body}</details>`;
}

function countTable(entries: readonly FileCount[]): string {
  return table(
    ["File", "Count"],
    entries.map((entry) => [entry.file, String(entry.count)]),
  );
}

/** The run-summary key/value rows (spec §13's metadata, verbatim). */
function summaryRows(meta: RunMeta, extra: ReadonlyArray<readonly [string, string]>): string {
  const rows: Array<readonly [string, string]> = [
    ["Tool", `pocket-comb ${meta.version}`],
    ["Action", meta.action],
    ["Config", meta.configPath],
    ["Config sha256", meta.configHash],
    ["Target", meta.target],
    ["Started", meta.startedAt],
    ["Duration", `${meta.durationMs} ms`],
    ["Mode", meta.dryRun ? "dry run" : "apply"],
    ["Workers", String(meta.workers)],
    [
      "Files",
      `${meta.counts.discovered} discovered · ${meta.counts.linted} linted · ` +
        `${meta.counts.dropped} dropped · ${meta.counts.touched} touched`,
    ],
    ...extra,
  ];
  return rows
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("");
}

function runHtml(report: RunReport): string {
  const editCount = report.edits.length;
  const byFile = new Map<string, typeof report.edits>();
  for (const edit of report.edits) {
    const list = byFile.get(edit.file);
    if (list === undefined) byFile.set(edit.file, [edit]);
    else list.push(edit);
  }

  const ledger = [...byFile.entries()]
    .map(([file, edits]) =>
      details(
        `${file} (${edits.length} edits)`,
        table(
          ["Line", "Rule", "Edit", "Form", "Before", "After"],
          edits.map((edit) => [
            String(edit.line),
            edit.rule,
            edit.editType,
            edit.form ?? "",
            edit.before ?? "",
            edit.after ?? "",
          ]),
        ),
      ),
    )
    .join("\n");

  return frame(
    report.meta,
    summaryRows(report.meta, [
      ["Edits", String(editCount)],
      ...(report.hint === undefined ? [] : [["Next step", report.hint] as const]),
    ]),
    [
      section(
        "By rule",
        table(["Rule", "Count"], report.byRule.map((entry) => [entry.rule, String(entry.count)])),
      ),
      section(
        "By form",
        table(["Form", "Count"], report.byForm.map((entry) => [entry.form, String(entry.count)])),
      ),
      section("By file", countTable(report.byFile)),
    ].join("\n"),
    `<h2>Ledger <span class="count">${editCount} edits</span></h2>\n${ledger || "<p>No edits.</p>"}`,
  );
}

function censusHtml(report: CensusReport): string {
  const directiveCount = report.totals.reduce((sum, total) => sum + total.count, 0);
  const totals = table(
    ["Form", "Rule", "Count"],
    report.totals.map((total) => [total.form, total.rule ?? "(bare)", String(total.count)]),
  );

  const perFile = report.byFile
    .map((entry) =>
      details(
        `${entry.file} (${entry.count} directives)`,
        `<p>${entry.count} directives in this file.</p>`,
      ),
    )
    .join("\n");

  return frame(
    report.meta,
    summaryRows(report.meta, [
      ["Directives", String(directiveCount)],
      ["Files", `${report.byFile.length} with directives`],
    ]),
    [
      section("Totals by form and rule", totals),
      section("By file", countTable(report.byFile)),
    ].join("\n"),
    `<h2>Files <span class="count">${directiveCount} directives</span></h2>\n${perFile || "<p>No directives.</p>"}`,
  );
}

function section(heading: string, body: string): string {
  return `<section>\n<h2>${escapeHtml(heading)}</h2>\n${body}\n</section>`;
}

/**
 * The one self-contained page frame (spec §13): inline CSS, no external assets,
 * no JavaScript at all. `RunReport` and `CensusReport` share it.
 */
function frame(meta: RunMeta, summary: string, rollups: string, ledger: string): string {
  const subtitle = `${meta.action} · ${meta.dryRun ? "dry run" : "apply"} · ${meta.startedAt}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pocket-comb ${escapeHtml(meta.action)} report</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
.sub { margin: 0; opacity: .7; }
.count { font-weight: 400; opacity: .7; font-size: .9rem; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: .35rem .6rem; border-bottom: 1px solid rgba(128,128,128,.3); }
thead th { border-bottom-width: 2px; }
table.kv th { width: 12rem; font-weight: 600; }
details { margin: .5rem 0; }
summary { cursor: pointer; padding: .35rem .6rem; border: 1px solid rgba(128,128,128,.35); border-radius: 6px; }
details[open] summary { border-radius: 6px 6px 0 0; }
details table { margin-top: .25rem; }
</style>
</head>
<body>
<main>
<header>
<h1>pocket-comb report</h1>
<p class="sub">${escapeHtml(subtitle)}</p>
</header>
<section>
<h2>Run summary</h2>
<table class="kv"><tbody>${summary}</tbody></table>
</section>
<section>
<h2>Rollups</h2>
${rollups}
</section>
<section>
${ledger}
</section>
</main>
</body>
</html>
`;
}

/**
 * The HTML report (default format, spec §13): run summary, rollups and the full
 * ledger behind per-file `<details>` drill-downs; a census renders in the same
 * frame.
 */
export function renderHtml(report: ReportData): string {
  return isCensusReport(report) ? censusHtml(report) : runHtml(report);
}
