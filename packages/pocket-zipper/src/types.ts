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

export type ExceptionStatus = "used" | "dangling" | "spent" | "expired";

/**
 * A policy duration literal: a positive integer plus one of two units, strict
 * lowercase — `d` (exact days) or `mo` (calendar months, clamped to month
 * end). Constrained at runtime by the `^\d+(d|mo)$` grammar in policy.ts; the
 * template-literal type is a convenience, not the validator.
 */
export type DurationLiteral = `${number}d` | `${number}mo`;

/** The declared host value space. The can-guarantee subset is a ticket-07 concern. */
export type Host =
  | "github"
  | "gitlab-premium"
  | "gitlab-free"
  | "bitbucket-cloud"
  | "bitbucket-server";

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
  /** The expiry policy: fallbacks apply when absent (`30d` / `3mo`). */
  exceptions: {
    defaultExpiry: DurationLiteral;
    maxExpiry: DurationLiteral;
  };
  /** Combined-landing opt-in; semantics (ticket 07) do not apply in ticket 01. */
  allowSameChangeExceptions: boolean;
  /** Declared host; a valid forward declaration with or without the opt-in. */
  host: Host | null;
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
  status: ExceptionStatus;
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


