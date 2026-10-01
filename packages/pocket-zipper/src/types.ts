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
  | "BASELINE_DEFECT"
  | "POLICY_CHANGE"
  | "SEVERITY_FLOOR"
  | "EXPIRY_POLICY"
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

/** The three ESLint severity bands, ordered off < warn < error. */
export type SeverityBand = "off" | "warn" | "error";

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
  /** Optional minimum severity per governed rule; absent means no floor gate. */
  minSeverities?: Record<string, SeverityBand>;
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
  reference?: string;
  expires?: string;
  /** Capture-time reference data: the directive's line when the record was written. Never a match input. */
  line?: number;
}

/**
 * One `(rule, file)` pool's authorization arithmetic, as the JSON record
 * publishes it: how many records could have reserved a slot, how many did, and
 * how many are left over. The three are an exact partition — `leftover` is
 * `matched − used` — and an expired record is absent from `matched` because it
 * never reserved a slot (it is reported as `EXPIRED_EXCEPTION` instead). Only a
 * pool holding debt to allocate is published; see `allocateExceptions`.
 */
export interface PoolCount {
  rule: string;
  file: string;
  matched: number;
  used: number;
  leftover: number;
}

/**
 * One evaluation's whole answer, as `--json` publishes it.
 *
 * `schemaVersion` 2 added `unused`. v1 kept the cleanup *counts* in `summary`
 * and left the delete-ready pointers to the human report alone, on the argument
 * that the addresses are for a reader rather than for a statistics artifact. That
 * argument holds for a person and not for a script: a machine holding a v1
 * record could learn that two records were dangling and could not learn which
 * two. The pointers are the whole of the tool's cleanup output — the core never
 * deletes a record, so a pointer is the only route from "this record authorizes
 * nothing" to "cut these lines" — so they are now part of the published answer,
 * and the human report renders the same list rather than deriving its own.
 */
export interface EvaluationRecord {
  schemaVersion: 3;
  tool: { name: string; version: string };
  mode: Mode;
  verdict: Verdict;
  baseline: { ref: string; tree: string };
  proposedChange: { ref: string; tree: string };
  summary: EvaluationSummary;
  inventory: InventoryEntry[];
  exceptions: RecordExceptionEntry[];
  /**
   * Every unused baseline record, with the delete-ready pointer that finds it.
   * Empty unless some record authorizes nothing; see **Unused exception**.
   */
  unused: UnusedException[];
  errors: RecordError[];
}

/**
 * One unused record, as the cleanup surfaces print it: where it is in the
 * registry (entry number, how many the registry holds, the line span it
 * occupies), the record's own text, where its suppression lives now, and
 * whether this change is what made it unused. Every field here exists so a
 * maintainer can find the record and delete it in one glance — the core never
 * deletes it, so a pointer that does not land on the record is a broken
 * pointer, not a rough edge.
 *
 * Published in the record as `unused` since schemaVersion 2. v1 kept only the
 * counts in `summary`; the addresses were held back on the argument that they
 * are for a human reader, which turned out to be true for the report and false
 * for anything consuming the JSON.
 */
export interface UnusedException {
  status: Exclude<ExceptionStatus, "used">;
  /** 1-based position in the registry, alongside how many records it holds. */
  entry: number;
  entries: number;
  /**
   * The lines this record occupies **in the registry file**, inclusive — or
   * null where the document gave no offsets to measure from. Null prints the
   * entry number alone: a pointer is an instruction to cut specific lines, and
   * a range nobody verified is worse than none.
   *
   * Named for the file it indexes because `recorded` and `live` on this same
   * type are lines in a *different* file — the record's `line` field (ticket 03)
   * points into the source file, naming the suppression. This one points into
   * `.pocket-zipper/exceptions.yml`, naming the record. They are unrelated
   * numbers, neither derivable from the other, and storing this one would make
   * it stale the moment anyone edits the file above it.
   */
  registryLines: { start: number; end: number } | null;
  /** The record's own text, exactly as the registry writes it. */
  text: string;
  /**
   * Where the suppression this record excepts lives now, when one still does.
   * Null for a dangling record, which is exactly what makes its stored `line`
   * a *last known* location rather than a stale one.
   */
  live: { file: string; line: number } | null;
  /** The record's stored `line` — capture-time orientation, never identity. */
  recorded: number | null;
  /** This change removed the suppression the record excepted. */
  clearedByThisChange: boolean;
}

export interface EvaluationSummary {
  policy: {
    enabled: boolean;
    allowlist: string[] | null;
    /** Effective baseline-authoritative severity floors; null means no map. */
    minSeverities: Record<string, SeverityBand> | null;
  };
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
    /**
     * Baseline records whose `expires` runs past the policy's maximum: hygiene
     * that still authorizes, counted here and refused only when a change newly
     * writes one (see `expiryPolicyRefusals`). Never a gate failure on its own.
     */
    overlongExceptions: number;
    poolCounts: PoolCount[];
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
