import { renderCleanupSection, renderOverlongLine } from "./cleanup.js";
import { flaggedDebt, isExceptable, isNewDebt } from "./exception-match.js";
import { poolCountLine, remediationFields } from "./registry.js";
import { isUnpaired } from "./reconcile.js";
import { DEFAULT_MAX_EXPIRY } from "./policy.js";
import type {
  DurationLiteral,
  EvaluationRecord,
  EvaluationSummary,
  InventoryEntry,
  PoolCount,
  RecordError,
  UnusedException,
} from "./types.js";

export interface ReportOptions {
  verbose: boolean;
  tty: boolean;
  /**
   * The concrete `expires` date a remediation block suggests — the evaluation's
   * UTC date plus the baseline policy's `defaultExpiry`, resolved by the
   * pipeline (the renderer prints, it never computes dates).
   */
  suggestedExpiry?: string;
  /**
   * The baseline policy's `maxExpiry`, named by the overlong line for the same
   * reason. The count and the maximum come from one evaluation, so a report
   * holding a nonzero overlong count without one was produced against the
   * default policy.
   */
  maxExpiry?: DurationLiteral;
  /**
   * Who is reading the cleanup section, which decides whether it prints the
   * addresses or the rollup. A FAIL's reader is the author of the change, who
   * has to find the record; a verbose pass is a CI log, which wants the line a
   * repo's own step greps for. Defaults to the change author — the reader every
   * FAIL has and the only one the report is ever *for*.
   */
  audience?: CleanupAudience;
  /**
   * Every unused record, with the pointer that finds it. Resolved by the
   * pipeline and passed alongside the record rather than inside it: the record
   * is a frozen statistics artifact, and these addresses are for a reader.
   */
  unused?: readonly UnusedException[];
  /**
   * Non-failing config warnings (e.g. a wildcard path pattern matching nothing),
   * printed for a reader on stdout, never part of the record's `errors`.
   */
  warnings?: readonly string[];
}

/**
 * The three surfaces the cleanup section has to answer to. One enumeration
 * rather than two booleans, because the two are not free: which of the tally
 * and the addresses a reader gets is a single question about who they are.
 */
export type CleanupAudience =
  /** `check` FAIL — the addresses, under a pointer to the cleaning guide. */
  | "change-author"
  /** `check` / `pre-commit` `--verbose` PASS — the greppable rollup. */
  | "ci-log"
  /** `validate` — both: the addresses, and the rollup a CI step greps. */
  | "maintainer-sweep";

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

function color(text: string, code: string, tty: boolean): string {
  return tty ? `${code}${text}${RESET}` : text;
}

export function renderReport(record: EvaluationRecord, options: ReportOptions): string {
  const { verbose, tty, suggestedExpiry, maxExpiry, audience = "change-author" } = options;
  const unused = options.unused ?? [];
  const warnings = options.warnings ?? [];
  const lines: string[] = [];

  if (record.verdict === "excluded") {
    if (record.mode === "check" || verbose) {
      lines.push(color("pocket-zipper: EXCLUDED (policy disabled)", YELLOW, tty));
    }
    lines.push(...renderWarnings(warnings));
    return joinLines(lines);
  }

  if (record.verdict === "pass") {
    if (record.mode === "check" || verbose) {
      lines.push(color("pocket-zipper: PASS", GREEN, tty));
    }
    // Verbose is symmetric across modes: the pass path mirrors the fail
    // summary (dispositions, authorized new debt, exception cleanup) so the
    // recorded state is readable without parsing JSON. The default pass path
    // stays one verdict line in CI and silent in pre-commit.
    if (verbose) {
      lines.push(renderDispositionSummary(record.summary.dispositions));
      lines.push(...renderPoolCounts(record.summary.cleanup.poolCounts));
      lines.push(...renderAuthorizedDebt(record.inventory));
      lines.push(...renderCleanup(record.summary.cleanup, unused, maxExpiry, "ci-log"));
    }
    // A pass can still carry recorded signals, such as a config-off policy
    // change that was routed to review. Buried in the JSON record it would be
    // invisible; surface it.
    lines.push(...renderErrors(record.errors));
    lines.push(...renderWarnings(warnings));
    return joinLines(lines);
  }

  lines.push(color("pocket-zipper: FAIL", RED, tty));
  lines.push(renderDispositionSummary(record.summary.dispositions));
  lines.push(...renderPoolCounts(record.summary.cleanup.poolCounts));

  const flagged = flaggedDebt(record);
  const flaggedConfig = record.inventory.filter(
    (e) => isUnpaired(e) && e.exception === null && !isExceptable(e),
  );
  if (flagged.length > 0) {
    lines.push("");
    lines.push("New suppression debt requiring an exception:");
    for (const entry of flagged) {
      lines.push(...renderProblem(entry, tty, suggestedExpiry));
    }
  }
  if (flaggedConfig.length > 0) {
    lines.push("");
    lines.push("New config-level suppressions (policy change; not exceptable):");
    for (const entry of flaggedConfig) {
      lines.push(entryLine(entry));
    }
  }

  lines.push(...renderAuthorizedDebt(record.inventory));
  lines.push(...renderCleanup(record.summary.cleanup, unused, maxExpiry, "change-author"));
  lines.push(...renderErrors(record.errors));
  lines.push(...renderWarnings(warnings));

  return joinLines(lines);
}

function entryLine(entry: InventoryEntry): string {
  return `  ${entry.file}:${entry.lines.head ?? "?"}  ${entry.rule}  (${entry.suppressionType})`;
}

function renderErrors(errors: RecordError[]): string[] {
  if (errors.length === 0) return [];
  return ["", ...errors.map(renderError)];
}

function renderDispositionSummary(dispositions: EvaluationSummary["dispositions"]): string {
  return `  existing: ${dispositions.existing}  moved-existing: ${dispositions.movedExisting}  removed: ${dispositions.removed}  new: ${dispositions.new}  materially-changed: ${dispositions.materiallyChanged}`;
}

function renderAuthorizedDebt(inventory: InventoryEntry[]): string[] {
  const authorized = inventory.filter((e) => isNewDebt(e) && e.exception !== null);
  if (authorized.length === 0) return [];
  const out: string[] = ["", "New suppression debt authorized by exception:"];
  for (const entry of authorized) {
    out.push(entryLine(entry));
  }
  return out;
}

/**
 * One line per pool, unindented, in the record's own order — the arithmetic a
 * reader needs to see why a gate failed, or to confirm on a verbose pass that
 * their pool is well kept. It sits directly under the disposition summary
 * because it belongs with the tally, not with the blocks below it.
 */
function renderPoolCounts(pools: PoolCount[]): string[] {
  if (pools.length === 0) return [];
  return ["", ...pools.map(poolCountLine)];
}

/**
 * The cleanup block for one audience, in the shared wording. A FAIL names each
 * record's delete-ready pointer, because a FAIL is the report a change's author
 * is reading *now* and a dangling record they cannot find is a record nobody
 * deletes; a verbose pass prints the greppable rollup instead, the line a
 * repo's own CI greps to build whatever notification shape that host supports.
 * Neither surface deletes anything: every line is a pointer for a human to
 * action in a protected PR.
 */
function renderCleanup(
  cleanup: EvaluationSummary["cleanup"],
  unused: readonly UnusedException[],
  maxExpiry: DurationLiteral | undefined,
  audience: CleanupAudience,
): string[] {
  const ceiling = maxExpiry ?? DEFAULT_MAX_EXPIRY;
  // The section leads with the tally it accounts for; the overlong line rides
  // beneath it, on the evaluation surfaces only. It is hygiene like the rest:
  // a far-future date still authorizes, and only a change that newly writes one
  // is refused.
  const section = renderCleanupSection({ ...cleanup, unused }, { maxExpiry: ceiling, audience });
  const body = [...section.slice(1), ...renderOverlongLine(cleanup.overlongExceptions, ceiling)];
  return body.length === 0 ? [] : ["", ...body];
}

function renderProblem(
  entry: InventoryEntry,
  tty: boolean,
  suggestedExpiry?: string,
): string[] {
  const line = entry.lines.head ?? "?";
  const out: string[] = [];
  out.push(
    `  ${color(`${entry.file}:${line}`, DIM, tty)}  ${entry.rule}  (${entry.suppressionType}, ${entry.guardKind}, ${entry.disposition})`,
  );
  out.push("    remediate with:");
  remediationFields(entry, suggestedExpiry).forEach(([key, value], i) => {
    out.push(`    ${i === 0 ? "- " : "  "}${key}: ${value}`);
  });
  return out;
}

function renderError(err: RecordError): string {
  return `error[${err.code}]: ${err.message}`;
}

/** Non-failing config warnings, one per line — for a reader, never a gate term. */
function renderWarnings(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  return ["", ...warnings.map((warning) => `warning: ${warning}`)];
}

function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}
