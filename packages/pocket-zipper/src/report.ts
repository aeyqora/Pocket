import { poolCountLine, remediationFields } from "./registry.js";
import { DEFAULT_MAX_EXPIRY } from "./policy.js";
import type {
  DurationLiteral,
  EvaluationRecord,
  EvaluationSummary,
  InventoryEntry,
  PoolCount,
  RecordError,
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
}

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

function color(text: string, code: string, tty: boolean): string {
  return tty ? `${code}${text}${RESET}` : text;
}

export function renderReport(record: EvaluationRecord, options: ReportOptions): string {
  const { verbose, tty, suggestedExpiry, maxExpiry } = options;
  const lines: string[] = [];

  if (record.verdict === "excluded") {
    if (record.mode === "check" || verbose) {
      lines.push(color("pocket-zipper: EXCLUDED (policy disabled)", YELLOW, tty));
    }
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
      lines.push(...renderCleanup(record.summary.cleanup, maxExpiry));
    }
    // A pass can still carry recorded signals, such as a config-off policy
    // change that was routed to review. Buried in the JSON record it would be
    // invisible; surface it.
    lines.push(...renderErrors(record.errors));
    return joinLines(lines);
  }

  lines.push(color("pocket-zipper: FAIL", RED, tty));
  lines.push(renderDispositionSummary(record.summary.dispositions));
  lines.push(...renderPoolCounts(record.summary.cleanup.poolCounts));

  const flagged = flaggedDebt(record);
  const flaggedConfig = record.inventory.filter(
    (e) => isNewOrChanged(e) && e.exception === null && e.guardKind === "config-level",
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
  lines.push(...renderCleanup(record.summary.cleanup, maxExpiry));
  lines.push(...renderErrors(record.errors));

  return joinLines(lines);
}

function isNewOrChanged(entry: InventoryEntry): boolean {
  return entry.disposition === "new" || entry.disposition === "materially-changed";
}

/**
 * The debt a FAIL report flags: governed, directive-form, new or materially
 * changed, and uncovered by any record. One predicate for the two surfaces that
 * answer the same question — the block the report prints, and the ride-along the
 * report's author is offered (a FAIL with nothing here has nothing to author).
 */
export function flaggedDebt(record: EvaluationRecord): InventoryEntry[] {
  return record.inventory.filter(
    (e) => isNewOrChanged(e) && e.exception === null && e.guardKind === "directive",
  );
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
  const authorized = inventory.filter(
    (e) => isNewOrChanged(e) && e.exception !== null,
  );
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
 * The cleanup block, in two sentences. An overlong record is not an *unused*
 * one — it authorizes right up to its date — so it gets its own line beside the
 * unused tally rather than a place inside it, and it prints only when the count
 * is nonzero: a well-kept registry with one far-future record is hygiene to
 * report, not a standing comment on every run.
 */
function renderCleanup(
  cleanup: EvaluationSummary["cleanup"],
  maxExpiry: DurationLiteral | undefined,
): string[] {
  const lines: string[] = [];
  if (
    cleanup.danglingExceptions > 0 ||
    cleanup.spentExceptions > 0 ||
    cleanup.expiredExceptions > 0
  ) {
    lines.push(
      `Unused exceptions: dangling ${cleanup.danglingExceptions}, spent ${cleanup.spentExceptions}, expired ${cleanup.expiredExceptions}`,
    );
  }
  if (cleanup.overlongExceptions > 0) {
    lines.push(
      `  Overlong exceptions: ${cleanup.overlongExceptions} (expires past the ${maxExpiry ?? DEFAULT_MAX_EXPIRY} maximum)`,
    );
  }
  if (lines.length === 0) return [];
  return ["", ...lines];
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

function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}
