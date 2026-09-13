export type SuppressionType =
  | "next-line"
  | "line"
  | "block"
  | "file-level directive"
  | "config-off";

export type GuardKind = "directive" | "config-level";

export type Disposition =
  | "existing"
  | "moved-existing"
  | "new"
  | "removed"
  | "materially-changed";

export type ErrorCode =
  | "GIT_ERROR"
  | "ESLINT_ERROR"
  | "CONFIG_ERROR"
  | "POLICY_CHANGE"
  | "INTERNAL_ERROR";

export type Mode = "check" | "pre-commit";

export type Verdict = "pass" | "fail" | "excluded";

/** A directive / config-off expressed as a logical unit before reconciliation. */
export interface LogicalSuppression {
  fingerprint: string;
  rule: string;
  suppressionType: SuppressionType;
  guardKind: GuardKind;
  file: string;
  /** 1-based line of the directive comment (or the declaration waterline). */
  line: number;
  guardStart: number;
  guardEnd: number;
  /** Whitespace-normalized guarded statement/region text. */
  guardedContent: string;
  justification: string;
  canonicalText: string;
  /** Named rule tokens as written on the directive. */
  namedRules: string[];
  /** config-off only: normalized scope key. */
  scopeKey?: string;
}

/** A logical suppression with its reconciliation outcome attached. */
export interface ReconciledSuppression extends LogicalSuppression {
  disposition: Disposition;
  baselineLine: number | null;
  /** Matched baseline fingerprint partner, when continuous. */
  matchedBaseline?: LogicalSuppression;
  /** Exception fingerprint reference when authorized. */
  exception: ExceptionRef | null;
}

export interface ExceptionRef {
  fingerprint: string;
  suppressionType: SuppressionType;
  rule: string;
}

export interface Policy {
  enabled: boolean;
  governedRules: string[] | null;
}

export interface ExceptionRecord {
  rule: string;
  suppression_type: SuppressionType;
  fingerprint: string;
  file: string;
  type: "temporary" | "permanent";
  reason: string;
  owner: string;
  reference: string;
  expires?: string;
}

export interface EvaluationRecord {
  schemaVersion: 1;
  tool: { name: string; version: string };
  mode: Mode;
  verdict: Verdict;
  baseline: { ref: string; tree: string };
  proposedChange: { ref: string; tree: string };
  summary: EvaluationSummary;
  inventory: InventoryEntry[];
  exceptions: RecordExceptionEntry[];
  errors: RecordError[];
}

export interface EvaluationSummary {
  policy: { enabled: boolean; allowlist: string[] | null };
  governedRules: string[];
  dispositions: {
    existing: number;
    movedExisting: number;
    removed: number;
    new: number;
    materiallyChanged: number;
  };
  newDebt: { authorized: number; unauthorized: number };
  cleanup: {
    danglingExceptions: number;
    spentExceptions: number;
    expiredExceptions: number;
  };
}

export interface InventoryEntry {
  fingerprint: string;
  rule: string;
  suppressionType: SuppressionType;
  guardKind: GuardKind;
  disposition: Disposition;
  file: string;
  lines: { baseline: number | null; head: number | null };
  exception: ExceptionRef | null;
}

export interface RecordExceptionEntry {
  fingerprint: string;
  suppressionType: SuppressionType;
  rule: string;
  file: string;
  type: "temporary" | "permanent";
  status: "used" | "dangling" | "spent" | "expired";
}

export interface RecordError {
  code: ErrorCode;
  message: string;
  detail?: unknown;
}

export interface ChangeMap {
  /** post-image path -> status letter (A/M/D/R...) */
  files: Map<string, string>;
  /** rename pairs: new path -> old path */
  renames: Map<string, string>;
  /** paths that are binary (skipped) */
  binary: Set<string>;
}


