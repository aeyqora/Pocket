import { readFileSync } from "node:fs";
import { censusFiles } from "../census.js";
import { DEFAULT_EXTENSIONS, discover } from "../discovery.js";
import { OperationalError } from "../errors.js";
import { emitReport, type CensusReport } from "../report/index.js";
import { writeCensusSummary } from "../ui.js";
import { buildMeta, resolveOutput } from "./runner.js";
import type { ActionContext } from "./action.js";

/**
 * `pocket-comb inventory` — the read-only census (spec §6.6), end to end.
 *
 * Discover the target's files, scan each one's text with the shared full-file
 * scan, and tally every directive per `(form, rule)` and per file. **No ESLint
 * instance is constructed and no lint pass runs**: this action deliberately
 * bypasses the worker pool entirely (`pool.ts` / `engine.ts` are not imported),
 * which is what makes it the fastest action and lets it succeed on files ESLint
 * could not parse. It shares the report resolution, `RunMeta`, and emission with
 * the mutating actions (the read-only outlier of the shared runner).
 *
 * Read-only: no dry-run question applies and a successful census always exits 0.
 * A missing config or an empty target is still an operational error (exit 2),
 * mapped by the CLI's top-level handler.
 */
export async function runInventory(context: ActionContext): Promise<number> {
  const { parsed, config, io } = context;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const extensions = parsed.extensions ?? [...DEFAULT_EXTENSIONS];
  const { files } = await discover({ target: config.targetRoot, extensions });
  if (files.length === 0) {
    throw new OperationalError(`no files matched under ${config.targetRoot}`);
  }

  const census = censusFiles(files.map((file) => ({ file, text: readFileSync(file, "utf8") })));

  // Resolve the report before the human line: when the report streams to stdout
  // (`--out -`, the trend-store piping shape), the census line moves to stderr so
  // the piped CSV/JSON stays parseable (spec §13).
  const { report: carriedReport, humanOutput } = resolveOutput(context);

  const durationMs = Date.now() - startedAtMs;
  writeCensusSummary(humanOutput, {
    files: files.length,
    directives: census.directives,
    byForm: census.byForm,
    elapsedMs: durationMs,
  });

  // The census is inventory's "run": the report resolves after it, so a wizard
  // prompt (spec §5 step 7) follows the census line rather than preceding it.
  const report =
    context.resolveReport !== undefined ? await context.resolveReport() : carriedReport;

  if (report.enabled) {
    const meta = buildMeta(context, {
      action: "inventory",
      startedAt,
      durationMs,
      // A census has no write phase; `dryRun: false` is the renderers' convention
      // for a census (see report.test.ts).
      dryRun: false,
      // No pool: the main thread did the walk and the scan.
      workers: 1,
      discovered: files.length,
      // Inventory never lints; the census total is the real count and lives in
      // `totals`.
      outcomes: [],
      dropped: 0,
    });
    const data: CensusReport = { meta, totals: census.totals, byFile: census.byFile };
    emitReport({ data, format: report.format, out: report.out, stdout: io.output });
  }

  return 0;
}
