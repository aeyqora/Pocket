import type { ExceptionStatus } from "./types.js";

/**
 * The finding: one thing wrong with a protected file, addressed precisely enough
 * to fix without hunting — where it is, what it is called, and what was
 * expected instead.
 *
 * This is a module of its own because it is not about reading anything. It knows
 * what a diagnostic is and how severe it is; it has no opinion about YAML, about
 * the registry's grammar, or about where a finding comes from. Every surface that
 * reports a finding — the gate's `errors[]`, the head-side read, `validate`'s
 * report, the authoring session's transcript — crosses this interface rather
 * than the reader's.
 *
 * A **defect** is a condition under which a document cannot mean what its author
 * intended, and fails closed wherever it is read (`CONFIG_ERROR`, exit 2). A
 * **hygiene** finding is a well-formed but questionable condition: reported, and
 * never a failure on its own, so a legitimate transient state (a two-step
 * landing's dangling record) never blocks anything. A defective record is never
 * also classified as hygiene — it has no meaning to classify yet.
 */

/** Which of the two tiers a finding falls in. The tier is the whole policy. */
export type FindingSeverity = "defect" | "hygiene";

/**
 * The closed code vocabulary: a defect is one of the six ways a document can be
 * malformed, a hygiene finding one of the eight ways it can be untidy. A code
 * carries its severity, so no caller can invent a third tier or assign a
 * severity of its own choosing.
 */
export type FindingCode =
  // defects: the document is not a valid instance of the format
  | "MALFORMED"
  | "UNKNOWN_FIELD"
  | "MISSING_FIELD"
  | "INVALID_ENUM"
  | "FINGERPRINT_FORMAT"
  | "INVALID_DATE"
  // hygiene: the document is valid but worth reviewing
  | "UNKNOWN_RULE"
  | "OVERLONG_EXCEPTION"
  | "DANGLING_EXCEPTION"
  | "SPENT_EXCEPTION"
  | "EXPIRED_EXCEPTION"
  | "POOL_COUNTS"
  | "RENEWAL_BY_APPEND"
  | "HOST_MISMATCH"
  | "OWNERS_FILE_READINESS";

/*
 * `SPENT_EXCEPTION` is named here before anything emits it: it needs the
 * allocation-aware judgment of an evaluation, and a working-tree lint cannot tell
 * pre-existing debt from debt this change introduced — it has no baseline
 * (ticket 10's per-record findings).
 */

const SEVERITY = {
  // defects: the document is not a valid instance of the format
  MALFORMED: "defect",
  UNKNOWN_FIELD: "defect",
  MISSING_FIELD: "defect",
  INVALID_ENUM: "defect",
  FINGERPRINT_FORMAT: "defect",
  INVALID_DATE: "defect",
  // hygiene: the document is valid but worth reviewing
  UNKNOWN_RULE: "hygiene",
  OVERLONG_EXCEPTION: "hygiene",
  DANGLING_EXCEPTION: "hygiene",
  SPENT_EXCEPTION: "hygiene",
  EXPIRED_EXCEPTION: "hygiene",
  POOL_COUNTS: "hygiene",
  RENEWAL_BY_APPEND: "hygiene",
  HOST_MISMATCH: "hygiene",
  OWNERS_FILE_READINESS: "hygiene",
} as const satisfies Record<FindingCode, FindingSeverity>;

/**
 * How each utilization status is named as a hygiene finding. `used` is absent on
 * purpose: a record in use is the registry working, and there is nothing to
 * report about it.
 */
export const STATUS_CODES = {
  dangling: "DANGLING_EXCEPTION",
  spent: "SPENT_EXCEPTION",
  expired: "EXPIRED_EXCEPTION",
} as const satisfies Record<Exclude<ExceptionStatus, "used">, FindingCode>;

/** A line and column, or null where the document carried neither. */
export interface Position {
  readonly line: number | null;
  readonly column: number | null;
}

export interface Finding {
  readonly code: FindingCode;
  readonly severity: FindingSeverity;
  /** The protected file the finding lives in. */
  readonly path: string;
  /** 1-based index of the registry entry, or null for the document itself. */
  readonly entry: number | null;
  /** The record field the finding is about, or null for the document itself. */
  readonly field: string | null;
  readonly line: number | null;
  readonly column: number | null;
  /** What is wrong, as a self-contained sentence. */
  readonly message: string;
  /** What the format wants instead, when the fix is a shape or a value. */
  readonly expected?: string;
  /** What the file actually says, as written. */
  readonly actual?: string;
}

/** The fields a caller supplies; everything else the finding derives. */
export interface FindingInit {
  readonly code: FindingCode;
  readonly path: string;
  readonly entry?: number | null;
  readonly field?: string | null;
  readonly position?: Position;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

/**
 * The one constructor for a finding, taking its severity from its code so the
 * two cannot drift. Every finding in the tool is built here, which is what makes
 * the closed code vocabulary more than a type-level promise.
 */
export function finding(init: FindingInit): Finding {
  return {
    code: init.code,
    severity: SEVERITY[init.code],
    path: init.path,
    entry: init.entry ?? null,
    field: init.field ?? null,
    line: init.position?.line ?? null,
    column: init.position?.column ?? null,
    message: init.message,
    ...(init.expected === undefined ? {} : { expected: init.expected }),
    ...(init.actual === undefined ? {} : { actual: init.actual }),
  };
}

export function isDefect(f: Finding): boolean {
  return f.severity === "defect";
}

/**
 * The defects among some findings — the ones that fail closed. The partition is
 * the whole two-tier policy: a caller that must fail does so on this subset, and
 * a caller that reports everything takes `findings` as they came.
 */
export function defectsOf(findings: readonly Finding[]): Finding[] {
  return findings.filter(isDefect);
}

/**
 * The one diagnostic line for a finding, shared by every surface that reports
 * it: the baseline load's `errors[]`, the head-side read, `validate`, and the
 * authoring session. A CI failure reads the same whichever surface produced it.
 */
export function renderFinding(f: Finding): string {
  const where = f.entry === null ? "document" : `entry ${f.entry}`;
  const scope = f.field === null ? where : `${where} · ${f.field}`;
  const location =
    f.line === null ? f.path : `${f.path}:${f.line}:${f.column ?? 1}`;
  const clause =
    f.expected === undefined
      ? ""
      : ` — expected ${f.expected}${f.actual === undefined ? "" : `, got ${f.actual}`}`;
  return `${location}  ${f.code}  ${scope}  ${f.message}${clause}`;
}

/**
 * A defect about a whole protected document, for the one read that fails on a
 * document rather than on an entry: the strict config parse throws a single
 * message with no position. Built through the same constructor as every other
 * finding, so its severity comes from its code instead of being written out a
 * second time.
 */
export function documentDefect(path: string, message: string): Finding {
  return finding({ code: "MALFORMED", path, message });
}
