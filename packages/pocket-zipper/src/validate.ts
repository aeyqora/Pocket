import { LineCounter, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Pair } from "yaml";
import { PocketZipperError } from "./errors.js";
import { hostFamily, ownersCover, type HostFamily, type OwnersFile } from "./host-attestation.js";
import { matchKey } from "./identity.js";
import { expiryHorizon } from "./policy.js";
import { countKey, isOverlong, poolCountLine, type UnclaimedRecord } from "./registry.js";
import type {
  DurationLiteral,
  ExceptionRecord,
  ExceptionStatus,
  Host,
  RecordError,
  SuppressionType,
} from "./types.js";

/** The two protected files: the policy document and the exception registry. */
export const PROTECTED_CONFIG = ".pocket-zipper/config.yml";
export const PROTECTED_REGISTRY = ".pocket-zipper/exceptions.yml";

/**
 * The registry's known field set, in canonical field order. A record carrying
 * anything else is a defect, so the format is unambiguous: a field joins here
 * to be accepted and leaves here (with its advice in `REMOVED_FIELDS`) to be
 * rejected. The order is the record's field order, shared with the remediation
 * template in `remediationFields` and pinned against it by a test.
 */
const KNOWN_FIELDS = [
  "rule",
  "suppression_type",
  "fingerprint",
  "file",
  "type",
  "reason",
  "reference",
  "expires",
  "line",
] as const;

const KNOWN_FIELD_SET = new Set<string>(KNOWN_FIELDS);

/**
 * Fields the registry format no longer carries, each with the advice that
 * replaces its diagnostic. `owner` is the one so far: attribution is git
 * history, never re-derived in-tool, so a stale line is a defect naming the
 * field and the fix. Registering a removal here is what keeps an unregistered
 * field from degrading into a bare "unknown field" with no advice.
 */
const REMOVED_FIELDS = new Map<string, string>([
  ["owner", "removed from the registry format; delete this line"],
]);

/** The directive forms a record may except. `config-off` is policy track. */
const DIRECTIVE_TYPES: Exclude<SuppressionType, "config-off">[] = [
  "next-line",
  "line",
  "block",
  "file-level directive",
];

/** The lifecycle halves: a temporary record expires, a permanent one never does. */
const RECORD_TYPES = ["temporary", "permanent"] as const;

/** The fingerprint grammar: the versioned prefix plus 64 lowercase hex digits. */
const FINGERPRINT_RE = /^v1:sha256:[0-9a-f]{64}$/;

/** The date grammar: four-digit year, two-digit month, two-digit day, captured. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A finding is one thing wrong with a protected file, addressed precisely enough
 * to fix without hunting: where it is, what it is called, and what was expected
 * instead. Severity is two-tier, and the tier is the whole policy:
 *
 * - **defect** — the file is not a valid instance of the format. Fails closed
 *   everywhere it is read (`CONFIG_ERROR`, exit 2). A defective record is never
 *   also classified as hygiene: it has no meaning to classify yet.
 * - **hygiene** — the file is valid but says something worth reviewing. Reported,
 *   and never a failure on its own, so a legitimate transient state (a two-step
 *   landing's dangling record) never blocks anything.
 *
 * The code vocabulary is closed: a defect is one of the six ways a document can
 * be malformed, a hygiene finding one of the eight ways it can be untidy. The
 * severity a code carries is fixed here, so no caller can invent a third tier.
 */
export type FindingSeverity = "defect" | "hygiene";

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
 * `SPENT_EXCEPTION` is still named here before anything emits it: it needs the
 * allocation-aware judgement of an evaluation, and a working-tree lint cannot
 * tell pre-existing debt from debt this change introduced — it has no baseline
 * (ticket 10's per-record findings).
 */

/**
 * The severity each code carries, in the one place a code is mapped to a tier:
 * a defect is one of the six ways a document can be malformed, a hygiene finding
 * one of the eight ways it can be untidy. Deriving the tier from the code rather
 * than writing it out per finding is what makes a third tier unrepresentable.
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
 * How each utilization status is named as a hygiene finding. `used` is absent
 * on purpose: a record in use is the registry working, and there is nothing to
 * report about it.
 */
const STATUS_CODES = {
  dangling: "DANGLING_EXCEPTION",
  spent: "SPENT_EXCEPTION",
  expired: "EXPIRED_EXCEPTION",
} as const satisfies Record<Exclude<ExceptionStatus, "used">, FindingCode>;

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

export interface Position {
  readonly line: number | null;
  readonly column: number | null;
}

/** One registry record, with the positions a finding about it needs. */
export interface RegistryEntry {
  /** 1-based position in the registry list — the index every finding names. */
  readonly index: number;
  readonly record: ExceptionRecord;
  /** Where the entry starts in the document. */
  readonly position: Position;
  /** Where each declared field is, for a finding about that field. */
  readonly fields: ReadonlyMap<string, Position>;
}

export interface RegistryValidation {
  /** The entries carrying no defect; a defective record is never classified. */
  readonly entries: RegistryEntry[];
  /** Every finding, in document order, defects and hygiene alike. */
  readonly findings: Finding[];
}

export function isDefect(finding: Finding): boolean {
  return finding.severity === "defect";
}

export function defectsOf(findings: readonly Finding[]): Finding[] {
  return findings.filter(isDefect);
}

/**
 * The one diagnostic line for a finding, shared by every surface that reports
 * it: the baseline load's `errors[]`, the head-side read, and `validate`. A CI
 * failure reads the same whichever surface produced it.
 */
export function renderFinding(finding: Finding): string {
  const where = finding.entry === null ? "document" : `entry ${finding.entry}`;
  const scope = finding.field === null ? where : `${where} · ${finding.field}`;
  const location =
    finding.line === null
      ? finding.path
      : `${finding.path}:${finding.line}:${finding.column ?? 1}`;
  const clause =
    finding.expected === undefined
      ? ""
      : ` — expected ${finding.expected}${finding.actual === undefined ? "" : `, got ${finding.actual}`}`;
  return `${location}  ${finding.code}  ${scope}  ${finding.message}${clause}`;
}

/**
 * A defect about a whole protected document, for the one read that fails on a
 * document rather than on an entry: the strict config parse (ticket 01) throws
 * a single message with no position. Built through the same constructor as
 * every other finding, so its severity comes from its code instead of being
 * written out a second time.
 */
export function documentDefect(path: string, message: string): Finding {
  return of({ code: "MALFORMED", path, message });
}

/**
 * Read a registry document into records and findings, never throwing: every
 * problem is a finding, and every finding is reportable. Diagnostics come from
 * the YAML document API with a line counter, so a message carries the position
 * of the thing it is complaining about.
 */
export function validateRegistry(raw: string | null): RegistryValidation {
  if (raw === null || raw.trim().length === 0) return { entries: [], findings: [] };

  const lineCounter = new LineCounter();
  const doc = parseDocument(raw, { lineCounter });
  const at = positioner(lineCounter);
  const findings: Finding[] = [];

  for (const err of doc.errors) {
    findings.push(
      of({
        code: "MALFORMED",
        path: PROTECTED_REGISTRY,
        position: { line: err.linePos?.[0]?.line ?? null, column: err.linePos?.[0]?.col ?? null },
        message: parseErrorMessage(err.message),
        expected: "a well-formed YAML document",
        actual: "YAML the parser rejects",
      }),
    );
  }
  // Unparseable YAML leaves no reliable shape or positions to read: the parse
  // error is the one cause, and reporting past it would only be noise.
  if (findings.length > 0) return { entries: [], findings };

  const contents: unknown = doc.contents;
  // A document with nothing in it is an empty registry, not a malformed one: a
  // headerless comment or a bare newline is how "not yet" is written, and the
  // same tolerance `viewPolicy` shows the config.
  if (contents === null) return { entries: [], findings };
  if (!isSeq(contents)) {
    findings.push(...documentShapeFindings(contents, at));
    return { entries: [], findings };
  }

  const entries: RegistryEntry[] = [];
  for (const [index, item] of contents.items.entries()) {
    const read = readEntry(item, index + 1, raw, at);
    findings.push(...read.findings);
    if (read.entry) entries.push(read.entry);
  }
  return { entries, findings };
}

/**
 * The failing read every evaluation path uses, for both trees: the shared
 * validation, then fail-closed on any defect. The error carries the findings
 * themselves, so a caller can report one diagnostic per defect; its message is
 * those same lines joined, so a caller that reports the error whole still reads
 * correctly. A registry malformed in the head of a change is the same defect as
 * one malformed at baseline — a file this tool cannot read is a defect, never a
 * delta to judge.
 */
export function loadRegistry(raw: string | null): ExceptionRecord[] {
  const { entries, findings } = validateRegistry(raw);
  const defects = defectsOf(findings);
  if (defects.length > 0) {
    throw new RegistryDefectError(defects);
  }
  return entries.map((entry) => entry.record);
}

/**
 * A registry read that found defects. The findings are a typed field rather than
 * an untyped `detail`, so the surface that reports them never has to guess
 * whether it is holding findings or some other error's payload.
 */
export class RegistryDefectError extends PocketZipperError {
  constructor(readonly findings: readonly Finding[]) {
    super("CONFIG_ERROR", findings.map(renderFinding).join("\n"), findings);
    this.name = "RegistryDefectError";
  }
}

/**
 * The `errors[]` entries a failed read contributes: one per defect, so the JSON
 * record stays machine-readable while each message is the diagnostic line every
 * other surface prints. Any other error contributes itself.
 */
export function errorRecords(err: PocketZipperError): RecordError[] {
  if (!(err instanceof RegistryDefectError)) {
    return [{ code: err.code, message: err.message, detail: err.detail }];
  }
  return err.findings.map((finding) => ({
    code: "CONFIG_ERROR" as const,
    message: renderFinding(finding),
  }));
}

// --- document shape -------------------------------------------------------

type Positioner = (node: unknown) => Position;

/** Resolves a node's source offset to a 1-based line and column. */
function positioner(lineCounter: LineCounter): Positioner {
  return (node) => {
    const start = (node as { range?: [number, number, number] } | null | undefined)?.range?.[0];
    if (start === undefined) return { line: null, column: null };
    const { line, col } = lineCounter.linePos(start);
    return { line, column: col };
  };
}

/**
 * A registry that is not a list. The copy/paste class gets its own diagnostic:
 * a document wrapped in an `exceptions:` header is a config-shaped habit, and
 * naming it turns a puzzling shape error into a one-line fix.
 */
function documentShapeFindings(contents: unknown, at: Positioner): Finding[] {
  if (isMap(contents)) {
    const solePair = contents.items.length === 1 ? contents.items[0] : undefined;
    if (solePair && scalarKeyOf(solePair) === "exceptions") {
      return [
        of({
          code: "MALFORMED",
          path: PROTECTED_REGISTRY,
          field: "exceptions",
          position: at(solePair.key ?? solePair.value),
          message:
            "entries must be a top-level list, not nested under an `exceptions:` header",
          expected: "a top-level list of records",
          actual: "a mapping with the key 'exceptions'",
        }),
      ];
    }
  }
  return [
    of({
      code: "MALFORMED",
      path: PROTECTED_REGISTRY,
      position: at(contents),
      message: "the registry document is not a list of records",
      expected: "a top-level list of records",
      actual: describeNode(contents),
    }),
  ];
}

/** A field as the document has it: its value, and where the field is written. */
interface FieldRef {
  readonly name: string;
  readonly value: unknown;
  readonly position: Position;
  /** The value exactly as written, for a diagnostic that quotes it. */
  readonly source: string;
}

/** Records a defect against one field of the entry being read. */
type Reporter = (
  ref: FieldRef,
  init: { code: FindingCode; message: string; expected?: string; actual?: string },
) => void;

interface EntryRead {
  readonly entry: RegistryEntry | null;
  readonly findings: Finding[];
}

function readEntry(item: unknown, index: number, raw: string, at: Positioner): EntryRead {
  const findings: Finding[] = [];
  const position = at(item);
  /** Findings in the order the document writes them, so a reader scans the
   * record top to bottom: an unknown field at the end of a record is not
   * reported ahead of a defective field at its start. Ties keep the order they
   * were found in, which is canonical field order. */
  const done = (entry: RegistryEntry | null): EntryRead => ({
    entry,
    findings: findings.sort(byPosition),
  });

  if (!isMap(item)) {
    findings.push(
      of({
        code: "MALFORMED",
        path: PROTECTED_REGISTRY,
        entry: index,
        position,
        message: "a registry entry is not a mapping of record fields",
        expected: `a mapping of record fields (${KNOWN_FIELDS.join(", ")})`,
        actual: describeNode(item),
      }),
    );
    return done(null);
  }

  // Read the fields in document order, so the findings come out in the order
  // they are written, and an unknown field is named where it sits.
  const declared = new Map<string, FieldRef>();
  for (const pair of item.items) {
    const name = scalarKeyOf(pair);
    // A field is addressed by where its *name* is written, which is the column
    // the author has to delete or edit.
    const keyAt = at(pair.key ?? pair.value);
    if (name === null) {
      findings.push(
        of({
          code: "MALFORMED",
          path: PROTECTED_REGISTRY,
          entry: index,
          position: keyAt,
          message: "a field name is not a plain string",
          expected: `one of ${KNOWN_FIELDS.join(", ")}`,
          actual: describeNode(pair.key),
        }),
      );
      continue;
    }
    if (!KNOWN_FIELD_SET.has(name)) {
      const removed = REMOVED_FIELDS.get(name);
      findings.push(
        of({
          code: "UNKNOWN_FIELD",
          path: PROTECTED_REGISTRY,
          entry: index,
          field: name,
          position: keyAt,
          message: removed
            ? `unknown field '${name}' — ${removed}`
            : `unknown field '${name}' — known fields are ${KNOWN_FIELDS.join(", ")}`,
        }),
      );
      continue;
    }
    if (!declared.has(name)) {
      declared.set(name, {
        name,
        value: pair.value,
        position: keyAt,
        source: sourceOf(pair.value, raw),
      });
    }
  }

  // Value checks run in canonical field order, so `expires` is judged against
  // `type` wherever the author wrote them.
  const report: Reporter = (ref, init) => {
    findings.push(
      of({
        ...init,
        path: PROTECTED_REGISTRY,
        entry: index,
        field: ref.name,
        position: ref.position,
      }),
    );
  };
  const read = (name: string): FieldRef => {
    const found = declared.get(name);
    return (
      found ?? {
        name,
        value: undefined,
        // An absent field is reported where the entry starts: the author is
        // looking at the record, not at a line that does not exist.
        position,
        source: "",
      }
    );
  };

  const rule = requiredText(read("rule"), report);
  const suppressionType = enumText(read("suppression_type"), DIRECTIVE_TYPES, report, {
    // Config-level suppressions are policy track and never exceptable debt;
    // saying so beats leaving the author to wonder why the one shape they can
    // see in the config is refused.
    "config-off":
      "'suppression_type' cannot be 'config-off' — a config-level suppression is a policy change, not exceptable debt",
  });
  const fingerprint = fingerprintText(read("fingerprint"), report);
  const file = requiredText(read("file"), report);
  const type = enumText(read("type"), RECORD_TYPES, report);
  const reason = requiredText(read("reason"), report);
  const reference = optionalText(read("reference"), report);
  const expires = expiryText(read("expires"), type, report);
  const line = lineNumber(read("line"), report);

  // A defective entry yields no record: it has no meaning to match on or to
  // classify, so it is never also reported as hygiene.
  if (
    findings.length > 0 ||
    rule === undefined ||
    suppressionType === undefined ||
    fingerprint === undefined ||
    file === undefined ||
    type === undefined ||
    reason === undefined
  ) {
    return done(null);
  }

  const record: ExceptionRecord = {
    rule,
    suppression_type: suppressionType,
    fingerprint,
    file,
    type,
    reason,
    ...(reference ? { reference } : {}),
    ...(expires ? { expires } : {}),
    ...(line === undefined ? {} : { line }),
  };
  const fields = new Map(
    [...declared].map(([name, ref]) => [name, ref.position] as const),
  );
  return done({ index, record, position, fields });
}

/** Document order, with a finding that has no position reading as the first. */
function byPosition(a: Finding, b: Finding): number {
  return (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0);
}

// --- field readers --------------------------------------------------------

/** A required field: present as a non-empty string, or a defect naming which. */
function requiredText(ref: FieldRef, report: Reporter): string | undefined {
  if (ref.value === undefined) {
    report(ref, {
      code: "MISSING_FIELD",
      message: `'${ref.name}' is required`,
      expected: "a non-empty string",
    });
    return undefined;
  }
  const text = textOf(ref.value);
  if (text === undefined) {
    report(ref, {
      code: "MALFORMED",
      message: `'${ref.name}' must be a non-empty string`,
      expected: "a non-empty string",
      actual: describeNode(ref.value),
    });
    return undefined;
  }
  return text;
}

/**
 * An optional field reads an explicitly empty YAML value (`reference:`) as
 * absent rather than as a defect — for an optional field the two say the same
 * thing, and a writer that skips a prompt as a bare key shouldn't produce a
 * record the loader rejects.
 */
function optionalText(ref: FieldRef, report: Reporter): string | undefined {
  if (isAbsent(ref)) return undefined;
  const text = textOf(ref.value);
  if (text === undefined) {
    report(ref, {
      code: "MALFORMED",
      message: `'${ref.name}' must be a non-empty string when present`,
      expected: "a non-empty string",
      actual: describeNode(ref.value),
    });
    return undefined;
  }
  return text;
}

function enumText<T extends string>(
  ref: FieldRef,
  values: readonly T[],
  report: Reporter,
  hints: Record<string, string> = {},
): T | undefined {
  const text = requiredText(ref, report);
  if (text === undefined || isOneOf(text, values)) return text;
  report(ref, {
    code: "INVALID_ENUM",
    message:
      hints[text] ?? `'${ref.name}' is not one of ${values.map((v) => `'${v}'`).join(", ")}`,
    expected: `one of ${values.join(", ")}`,
    actual: ref.source,
  });
  return undefined;
}

/**
 * A fingerprint is present, non-empty, and in the versioned grammar. Checked
 * here rather than after the readers so a record's defects come out in
 * canonical field order no matter which field is wrong.
 */
function fingerprintText(ref: FieldRef, report: Reporter): string | undefined {
  const text = requiredText(ref, report);
  if (text === undefined || FINGERPRINT_RE.test(text)) return text;
  report(ref, {
    code: "FINGERPRINT_FORMAT",
    message: "'fingerprint' is not a valid fingerprint",
    expected: "v1:sha256:<64 lowercase hex digits>",
    actual: text,
  });
  return undefined;
}

/** Membership that narrows the value to the union, so the reader needs no cast. */
function isOneOf<T extends string>(text: string, values: readonly T[]): text is T {
  return (values as readonly string[]).includes(text);
}

/** A field that is not declared at all, or declared with nothing after it. */
function isAbsent(ref: FieldRef): boolean {
  return ref.value === undefined || valueOf(ref.value) === null;
}

/**
 * `expires` follows the lifecycle: required by a temporary record, forbidden on
 * a permanent one, and a real calendar date either way. "Declared" means the
 * field is written at all — a bare `expires:` is a declaration of nothing, which
 * is a permanent record's violation and a temporary record's missing date, not a
 * third thing both accept. A record whose `type` is itself defective gets the
 * date checked and the pairing left alone — the `type` defect already says what
 * is wrong with the record.
 */
function expiryText(
  ref: FieldRef,
  type: string | undefined,
  report: Reporter,
): string | undefined {
  const absent = ref.value === undefined;
  if (type === "temporary" && absent) {
    report(ref, {
      code: "MISSING_FIELD",
      message: "'expires' is required when 'type' is temporary",
      expected: "a YYYY-MM-DD date",
    });
    return undefined;
  }
  if (type === "permanent" && !absent) {
    report(ref, {
      code: "INVALID_ENUM",
      message: "'expires' must not be declared when 'type' is permanent",
      expected: "no 'expires' field on a permanent record",
      actual: ref.source,
    });
    return undefined;
  }
  if (absent) return undefined;
  const text = textOf(ref.value);
  if (text === undefined || !DATE_RE.test(text)) {
    report(ref, {
      code: "INVALID_DATE",
      message: "'expires' is not a date in YYYY-MM-DD form",
      expected: "YYYY-MM-DD",
      actual: ref.source,
    });
    return undefined;
  }
  if (!isCalendarDate(text)) {
    report(ref, {
      code: "INVALID_DATE",
      message: "'expires' is not a real calendar date",
      expected: "a real date in YYYY-MM-DD form",
      actual: text,
    });
    return undefined;
  }
  return text;
}

/**
 * `line` is capture-time reference data, never a match input: a 1-based integer
 * when present, and read leniently (an explicitly empty value is absent) since
 * a value read here can never widen an authorization.
 */
function lineNumber(ref: FieldRef, report: Reporter): number | undefined {
  if (isAbsent(ref)) return undefined;
  const value = valueOf(ref.value);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    report(ref, {
      code: "MALFORMED",
      message: "'line' must be an integer of at least 1",
      expected: "an integer of at least 1",
      actual: describeNode(ref.value),
    });
    return undefined;
  }
  return value;
}

// --- value descriptions ---------------------------------------------------

/**
 * The JavaScript value a node holds, for a field compared as a value rather
 * than described. A scalar node wraps its value; a collection has none, so it
 * is returned as-is and fails the comparison that asked for a scalar.
 */
function valueOf(node: unknown): unknown {
  return isScalar(node) ? node.value : node;
}

function textOf(value: unknown): string | undefined {
  if (!isScalar(value)) return undefined;
  const v = value.value;
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function scalarKeyOf(pair: Pair<unknown, unknown>): string | null {
  const key = pair.key;
  if (!isScalar(key)) return null;
  return typeof key.value === "string" ? key.value : null;
}

/** A node as written, so a diagnostic quotes the author's own text. */
function sourceOf(node: unknown, raw: string): string {
  const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
  const text = range ? raw.slice(range[0], range[1]).trim() : "";
  // A value written as nothing has no text to quote; describing it reads better
  // than a diagnostic ending in "got " with nothing after it.
  return text.length > 0 ? truncate(text) : describeNode(node);
}

function describeNode(node: unknown): string {
  if (node === null || node === undefined) return "nothing";
  if (isMap(node)) {
    const keys = node.items
      .map((pair) => scalarKeyOf(pair))
      .filter((key): key is string => key !== null);
    return keys.length > 0 ? `a mapping (${truncate(keys.join(", "))})` : "an empty mapping";
  }
  if (isSeq(node)) return "a list";
  if (isScalar(node)) {
    const value = node.value;
    if (value === null) return "an empty value";
    if (typeof value === "number" || typeof value === "boolean") {
      return `the ${typeof value} ${value}`;
    }
    return `${typeof value === "string" ? "the string" : `the ${typeof value}`} ${truncate(JSON.stringify(value))}`;
  }
  return "a value";
}

function truncate(text: string, limit = 80): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * A YAML parse error on one line, minus the trailing `at line L, column C:`
 * the parser appends. The finding already carries the position, and a clause
 * that trails off after a colon reads as a message the tool failed to finish.
 */
function parseErrorMessage(message: string): string {
  const first = message.split("\n")[0] ?? message;
  return first.replace(/\s+at line \d+, column \d+:$/, "").trimEnd();
}

/**
 * Real calendar validity, not a regex: `2026-02-30` is well-formed and does not
 * exist. The year is set explicitly so a four-digit year below 100 is not folded
 * into the 1900s the way `Date.UTC` would fold it.
 */
function isCalendarDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

// --- hygiene --------------------------------------------------------------

export interface HygieneContext {
  /** The evaluation's date; expiry horizons and staleness are relative to it. */
  readonly now: Date;
  /** The policy's expiry maximum; a temporary past this horizon is overlong. */
  readonly maxExpiry: DurationLiteral;
  /** Rule ids ESLint knows here; an empty set skips the referential check. */
  readonly knownRules: ReadonlySet<string>;
  /** The live line of the suppression each record matches, where one exists. */
  readonly liveLines: ReadonlyMap<ExceptionRecord, number>;
}

/**
 * Hygiene a record's own text carries: a rule id ESLint does not know here, and
 * a temporary running past the policy's maximum horizon. Neither is a failure —
 * both still authorize, and a record may legitimately outlive the policy that
 * was in force when it was written.
 */
export function recordHygiene(
  entries: readonly RegistryEntry[],
  ctx: HygieneContext,
): Finding[] {
  const findings: Finding[] = [];
  const horizon = expiryHorizon(ctx.now, ctx.maxExpiry);
  for (const { index, record, position, fields } of entries) {
    const emit = (
      name: string | null,
      init: { code: FindingCode; message: string; expected?: string; actual?: string },
    ): void => {
      findings.push(
        of({
          ...init,
          path: PROTECTED_REGISTRY,
          entry: index,
          field: name,
          position: name === null ? position : (fields.get(name) ?? position),
        }),
      );
    };

    if (ctx.knownRules.size > 0 && !ctx.knownRules.has(record.rule)) {
      emit("rule", {
        code: "UNKNOWN_RULE",
        message: "'rule' names a rule ESLint does not know here",
        expected: "a core rule or one a configured plugin contributes",
        actual: record.rule,
      });
    }
    if (isOverlong(record, horizon)) {
      const stale = staleNote(record, ctx);
      emit("expires", {
        code: "OVERLONG_EXCEPTION",
        message: `'expires' runs past the policy's ${ctx.maxExpiry} maximum${stale}`,
        expected: `on or before ${horizon} (${ctx.maxExpiry} from today)`,
        actual: record.expires,
      });
    }
  }
  return findings;
}

/**
 * Hygiene a record's relationship to the tree carries: a record no suppression
 * matches (dangling), one whose suppression has become pre-existing debt
 * (spent), and one past its expiry (expired). Expiry takes precedence, the way
 * authorization does, so an expired record reads as expired even when its
 * suppression is still there. A record the status map says nothing about is
 * unjudged, not dangling — its file could not be read — and is left unreported.
 */
export function statusHygiene(
  entries: readonly RegistryEntry[],
  statuses: ReadonlyMap<ExceptionRecord, ExceptionStatus>,
  ctx: HygieneContext,
): Finding[] {
  const findings: Finding[] = [];
  for (const { index, record, position } of entries) {
    const status = statuses.get(record);
    if (status === undefined || status === "used") continue;
    const stale = status === "dangling" ? "" : staleNote(record, ctx);
    const message =
      status === "expired"
        ? `expired ${record.expires}; the record authorizes nothing${stale}`
        : status === "spent"
          ? `the suppression it excepts is pre-existing debt; the record is spent${stale}`
          : record.line === undefined
            ? `no suppression matches this record in ${record.file}`
            : `no suppression matches this record in ${record.file} (last known: line ${record.line})`;
    findings.push(
      of({
        code: STATUS_CODES[status],
        path: PROTECTED_REGISTRY,
        entry: index,
        position,
        message,
      }),
    );
  }
  return findings;
}

/**
 * The informational stale clause: a record's `line` is capture-time reference
 * data, so drift is orientation, not a finding. It rides along with whatever
 * other finding the record carries, and is never exit-changing on its own. A
 * dangling record has no live location to compare against, so its stored line is
 * reported as the last known one instead.
 */
function staleNote(record: ExceptionRecord, ctx: HygieneContext): string {
  const live = ctx.liveLines.get(record);
  if (live === undefined || record.line === undefined || record.line === live) return "";
  return ` (record says ${record.line}, currently at ${live})`;
}

/**
 * Hygiene a pool's *arithmetic* carries, over the records allocation left over.
 * Two findings, both read off one list, both anchored at a record rather than at
 * the pool so the author lands on the line to edit or delete:
 *
 * - `POOL_COUNTS` — the surplus story, once per `(rule, file)` pool with
 *   something left over, anchored at the first leftover record. The message is
 *   the whole finding: there is nothing expected or actual about arithmetic.
 *   A pool that balances says nothing, so a well-kept registry accumulates no
 *   findings nobody can act on.
 * - `RENEWAL_BY_APPEND` — a leftover record whose `expires` disagrees with the
 *   record that reserved the pool's first slot, which is the shape renewing by
 *   appending takes. A twin pool is *required* to hold different horizons (they
 *   authorize different suppressions), so nothing is accused unless a record no
 *   suppression needed moved its own date.
 *
 * Neither changes an exit code: a surplus record and a misdated one are both
 * questions worth asking, never failures.
 */
export function poolHygiene(
  entries: readonly RegistryEntry[],
  unclaimed: readonly UnclaimedRecord[],
): Finding[] {
  const byRecord = new Map<ExceptionRecord, RegistryEntry>();
  for (const entry of entries) byRecord.set(entry.record, entry);
  const findings: Finding[] = [];
  const at = (record: ExceptionRecord, init: Omit<FindingInit, "path" | "entry" | "position">): void => {
    const entry = byRecord.get(record);
    if (entry === undefined) return;
    findings.push(of({ ...init, path: PROTECTED_REGISTRY, entry: entry.index, position: entry.position }));
  };

  const counted = new Set<string>();
  for (const { record, pool } of unclaimed) {
    if (pool.leftover === 0 || counted.has(countKey(pool.rule, pool.file))) continue;
    counted.add(countKey(pool.rule, pool.file));
    at(record, { code: "POOL_COUNTS", message: poolCountLine(pool) });
  }
  for (const { record, reserved } of unclaimed) {
    // A pool exists only to hold a slot, and its first non-expired record takes
    // it, so `reserved` cannot be null here — nothing to compare, nothing to say.
    if (reserved === null || record.expires === reserved.expires) continue;
    at(record, {
      code: "RENEWAL_BY_APPEND",
      message:
        "'expires' differs from the record that reserved this pool — a renewal is an edit of the existing record, not an append",
    });
  }
  return findings;
}

/**
 * The two corroborations of a combined-landing repo, from facts the tool can
 * observe about the checkout rather than about the registry:
 *
 * - `HOST_MISMATCH` — the declared `host` against the checkout's own remote, at
 *   family granularity. Ungated: `host` is a valid forward declaration with or
 *   without the opt-in, and a wrong attestation is worth flagging in the posture
 *   every two-step repository runs.
 * - `OWNERS_FILE_READINESS` — a protected path the owners file claims no rule
 *   for, one finding per path, because a finding is about one file: the config
 *   and the registry are approved separately, and a repository owning one of
 *   them has exactly the one-gap fail-open this exists to surface. Gated on the
 *   opt-in, because it is the *combined* repository's own quiet loss of the
 *   distinct approval that makes its posture legal, and an owners file being
 *   present is not evidence that either path is owned. The gate reads the opt-in
 *   as the working tree declares it, not as the baseline committed it: this is a
 *   pre-push lint, so a repository about to turn the opt-in on is exactly the one
 *   whose owner gap is worth surfacing before the change that closes it, not
 *   after.
 *
 * Both are warn-only, and the silence is as deliberate as the findings. An
 * absent remote, a custom domain, a self-hosted GitLab, and an internal mirror
 * are all unclassifiable: absent is not disagreeing, and a finding that cries
 * wolf at a repository doing exactly the right thing is how this finding loses
 * the only value it has.
 */
export interface CombinedLandingFacts {
  /** The working tree's declared `host`; null when the config declares none. */
  readonly host: Host | null;
  /** Whether the working tree's policy declares the combined-landing opt-in. */
  readonly combined: boolean;
  /** The checkout's remote, classified; null when there is none or it is unknown. */
  readonly remote: HostFamily | null;
  /** The owners file and where it was found; null when there is none. */
  readonly owners: OwnersFile | null;
}

export function combinedLandingHygiene(facts: CombinedLandingFacts): Finding[] {
  const findings: Finding[] = [];
  const declared = hostFamily(facts.host);
  if (declared !== null && facts.remote !== null && declared !== facts.remote) {
    findings.push(
      of({
        code: "HOST_MISMATCH",
        path: PROTECTED_CONFIG,
        field: "host",
        message: `'host' declares ${facts.host}, but the checkout's own remote is on ${facts.remote} — a combined repository depends on that host's path-scoped approval for .pocket-zipper/**, and this repository is not on the host it claims`,
      }),
    );
  }
  if (facts.combined) {
    for (const path of [PROTECTED_CONFIG, PROTECTED_REGISTRY]) {
      if (facts.owners !== null && ownersCover(facts.owners.text, path)) continue;
      findings.push(
        of({
          code: "OWNERS_FILE_READINESS",
          path,
          message:
            facts.owners === null
              ? `no committed owners file claims ${path}, so the path is approved by whoever can push to the branch — combined landing substitutes that approval for the second protected PR, and without it there is none`
              : `the committed owners file (${facts.owners.path}) claims no rule matching ${path} — combined landing substitutes path-scoped ownership for the second protected PR, and an unclaimed path has none`,
        }),
      );
    }
  }
  return findings;
}

// --- finding construction -------------------------------------------------
interface FindingInit {
  readonly code: FindingCode;
  readonly path: string;
  readonly entry?: number | null;
  readonly field?: string | null;
  readonly position?: Position;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

/** Builds a finding, taking its severity from its code so the two cannot drift. */
function of(init: FindingInit): Finding {
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
