import type {
  Disposition,
  EvaluationRecord,
  EvaluationSummary,
  ExceptionRecord,
  ExceptionStatus,
  InventoryEntry,
  LogicalSuppression,
  Mode,
  Policy,
  ReconciledSuppression,
  RecordError,
  RecordExceptionEntry,
  Verdict,
} from "./types.js";
import { DEFAULT_POLICY } from "./policy.js";

export const TOOL_NAME = "pocket-zipper";
export const TOOL_VERSION = "0.2.0";
export const SCHEMA_VERSION = 1 as const;

export interface Summary {
  dispositions: EvaluationSummary["dispositions"];
  newDebt: EvaluationSummary["newDebt"];
}

/**
 * New debt is a property of directives only. A config-off (a rule disabled in
 * the flat config) is a policy change, not debt: it can never be excepted and
 * it never fails the gate on its own.
 */
function isNewDebt(suppression: ReconciledSuppression): boolean {
  return (
    suppression.guardKind === "directive" &&
    (suppression.disposition === "new" || suppression.disposition === "materially-changed")
  );
}

/**
 * The single derivation of disposition counts and new-debt totals. The gate,
 * the `consumedDebt` signal, and the record all read this one result, so they
 * cannot disagree about what counts as unauthorized new debt.
 */
export function summarize(
  head: ReconciledSuppression[],
  removedCount: number,
): Summary {
  return {
    dispositions: {
      existing: head.filter((h) => h.disposition === "existing").length,
      movedExisting: head.filter((h) => h.disposition === "moved-existing").length,
      removed: removedCount,
      new: head.filter((h) => h.disposition === "new").length,
      materiallyChanged: head.filter((h) => h.disposition === "materially-changed").length,
    },
    newDebt: {
      authorized: head.filter((h) => isNewDebt(h) && h.exception !== null).length,
      unauthorized: head.filter((h) => isNewDebt(h) && h.exception === null).length,
    },
  };
}

export interface BuildRecordInput {
  mode: Mode;
  verdict: Verdict;
  baseline: { ref: string; tree: string };
  proposedTree: string;
  policy: Policy;
  governedRules: string[];
  head: ReconciledSuppression[];
  removed: LogicalSuppression[];
  registry: ExceptionRecord[];
  cleanup: { expired: number; dangling: number; spent: number };
  exceptionStatuses: Map<ExceptionRecord, ExceptionStatus>;
  errors: RecordError[];
}

export interface ExcludedRecordInput {
  mode: Mode;
  baseline: { ref: string; tree: string };
  proposedTree: string;
  policy: Policy;
}

export interface FailureRecordInput {
  mode: Mode;
  baseRef: string;
  errors: RecordError[];
}

interface RecordParts {
  mode: Mode;
  verdict: Verdict;
  baseline: { ref: string; tree: string };
  proposedTree: string;
  summary: EvaluationSummary;
  inventory: InventoryEntry[];
  exceptions: RecordExceptionEntry[];
  errors: RecordError[];
}

export function buildRecord(input: BuildRecordInput): EvaluationRecord {
  const summary: EvaluationSummary = {
    policy: { enabled: input.policy.enabled, allowlist: input.policy.governedRules },
    governedRules: input.governedRules,
    ...summarize(input.head, input.removed.length),
    cleanup: {
      danglingExceptions: input.cleanup.dangling,
      spentExceptions: input.cleanup.spent,
      expiredExceptions: input.cleanup.expired,
    },
  };
  const exceptions: RecordExceptionEntry[] = input.registry.map((record) => ({
    fingerprint: record.fingerprint,
    suppressionType: record.suppression_type,
    rule: record.rule,
    file: record.file,
    type: record.type,
    status: input.exceptionStatuses.get(record) ?? "dangling",
  }));
  return recordOf({
    mode: input.mode,
    verdict: input.verdict,
    baseline: input.baseline,
    proposedTree: input.proposedTree,
    summary,
    inventory: inventoryEntries(input.head, input.removed),
    exceptions,
    errors: input.errors,
  });
}

export function excludedRecord(input: ExcludedRecordInput): EvaluationRecord {
  return recordOf({
    mode: input.mode,
    verdict: "excluded",
    baseline: input.baseline,
    proposedTree: input.proposedTree,
    summary: emptySummary(input.policy),
    inventory: [],
    exceptions: [],
    errors: [],
  });
}

export function failureRecord(input: FailureRecordInput): EvaluationRecord {
  return recordOf({
    mode: input.mode,
    verdict: "fail",
    baseline: { ref: input.baseRef, tree: "" },
    proposedTree: "",
    summary: emptySummary(),
    inventory: [],
    exceptions: [],
    errors: input.errors,
  });
}

function recordOf(parts: RecordParts): EvaluationRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    mode: parts.mode,
    verdict: parts.verdict,
    baseline: parts.baseline,
    proposedChange: {
      ref: parts.mode === "check" ? "HEAD" : "index",
      tree: parts.proposedTree,
    },
    summary: parts.summary,
    inventory: parts.inventory,
    exceptions: parts.exceptions,
    errors: parts.errors,
  };
}

function emptySummary(policy: Policy = DEFAULT_POLICY): EvaluationSummary {
  return {
    policy: { enabled: policy.enabled, allowlist: policy.governedRules },
    governedRules: [],
    dispositions: { existing: 0, movedExisting: 0, removed: 0, new: 0, materiallyChanged: 0 },
    newDebt: { authorized: 0, unauthorized: 0 },
    cleanup: { danglingExceptions: 0, spentExceptions: 0, expiredExceptions: 0 },
  };
}

function inventoryEntries(
  head: ReconciledSuppression[],
  removed: LogicalSuppression[],
): InventoryEntry[] {
  return [
    ...head.map((h) => ({
      fingerprint: h.fingerprint,
      rule: h.rule,
      suppressionType: h.suppressionType,
      guardKind: h.guardKind,
      disposition: h.disposition,
      file: h.file,
      lines: { baseline: h.baselineLine, head: h.line },
      exception: h.exception,
    })),
    ...removed.map((b) => ({
      fingerprint: b.fingerprint,
      rule: b.rule,
      suppressionType: b.suppressionType,
      guardKind: b.guardKind,
      disposition: "removed" as Disposition,
      file: b.file,
      lines: { baseline: b.line, head: null },
      exception: null,
    })),
  ];
}
