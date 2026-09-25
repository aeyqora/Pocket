import { parse as parseYaml } from "yaml";
import { configError } from "./errors.js";
import { matchKey } from "./identity.js";
import type {
  ExceptionRecord,
  ExceptionStatus,
  InventoryEntry,
  ReconciledSuppression,
  SuppressionType,
} from "./types.js";

const DIRECTIVE_TYPES: SuppressionType[] = [
  "next-line",
  "line",
  "block",
  "file-level directive",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The registry's known field set, in canonical field order. A record carrying
 * anything else is a defect, so the v2 format is unambiguous and a future field
 * has to register here (or be deliberately removed and named in `REMOVED_FIELDS`).
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
 * Fields removed from the registry format, each with the advice that replaces
 * its diagnostic. `owner` was dropped in v2: attribution is git history, never
 * re-derived in-tool, so a stale line is a defect naming the field to delete.
 */
const REMOVED_FIELDS = new Map<string, string>([
  ["owner", "removed from the registry format; delete this line"],
]);

function rejectUnknownFields(obj: Record<string, unknown>, where: string): void {
  for (const key of Object.keys(obj)) {
    if (KNOWN_FIELD_SET.has(key)) continue;
    const removed = REMOVED_FIELDS.get(key);
    throw configError(
      `${where}: unknown field '${key}' — ${
        removed ?? `known fields are ${KNOWN_FIELDS.join(", ")}`
      }`,
    );
  }
}

export function parseRegistry(raw: string | null): ExceptionRecord[] {
  if (raw === null || raw.trim().length === 0) return [];
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw configError("malformed .pocket-zipper/exceptions.yml", String(err));
  }
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) {
    throw configError(".pocket-zipper/exceptions.yml must be a list of records");
  }
  return doc.map((entry, index) => validateRecord(entry, index));
}

function validateRecord(entry: unknown, index: number): ExceptionRecord {
  const where = `.pocket-zipper/exceptions.yml[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw configError(`${where} must be a mapping`);
  }
  const obj = entry as Record<string, unknown>;
  rejectUnknownFields(obj, where);
  const rule = requireString(obj, "rule", where);
  const suppressionType = requireString(obj, "suppression_type", where) as SuppressionType;
  if (!DIRECTIVE_TYPES.includes(suppressionType)) {
    throw configError(
      `${where}: 'suppression_type' must be one of ${DIRECTIVE_TYPES.join(", ")}`,
    );
  }
  const fingerprint = requireString(obj, "fingerprint", where);
  const file = requireString(obj, "file", where);
  const type = requireString(obj, "type", where);
  if (type !== "temporary" && type !== "permanent") {
    throw configError(`${where}: 'type' must be 'temporary' or 'permanent'`);
  }
  const reason = requireString(obj, "reason", where);
  const reference = optionalString(obj, "reference", where);

  const expiresRaw = obj["expires"];
  let expires: string | undefined;
  if (type === "temporary") {
    const value = requireString(obj, "expires", where);
    if (!DATE_RE.test(value)) {
      throw configError(`${where}: 'expires' must be YYYY-MM-DD`);
    }
    expires = value;
  } else if (expiresRaw !== undefined && expiresRaw !== null) {
    throw configError(`${where}: permanent records must not carry 'expires'`);
  }

  const line = optionalLine(obj, where);

  return {
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
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  where: string,
): string {
  const value = obj[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(`${where}: '${field}' is required and must be a string`);
  }
  return value;
}

function optionalString(
  obj: Record<string, unknown>,
  field: string,
  where: string,
): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(`${where}: '${field}' must be a non-empty string when present`);
  }
  return value;
}

/** `line` is capture-time reference data: a 1-based integer, never a match input. */
function optionalLine(obj: Record<string, unknown>, where: string): number | undefined {
  const value = obj["line"];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw configError(`${where}: 'line' must be an integer of at least 1`);
  }
  return value;
}

export function isValidThrough(expires: string, now: Date): boolean {
  const endOfDay = new Date(`${expires}T23:59:59.999Z`);
  return now.getTime() <= endOfDay.getTime();
}

export function isExpired(expires: string | undefined, now: Date): boolean {
  if (!expires) return false;
  return !isValidThrough(expires, now);
}

/**
 * The ordered fields of the exception record that would remediate a flagged
 * suppression, with defaults for the human-authored ones. The single source of
 * the record's field list for the human report.
 */
export function remediationFields(
  entry: InventoryEntry,
  suggestedExpiry?: string,
): Array<[string, string]> {
  return [
    ["rule", entry.rule],
    ["suppression_type", entry.suppressionType],
    ["fingerprint", entry.fingerprint],
    ["file", entry.file],
    ["type", "temporary"],
    ["reason", "<why this suppression is necessary>"],
    ["reference", "<issue or PR link>"],
    ["expires", suggestedExpiry ?? "<YYYY-MM-DD>"],
    ["line", String(entry.lines.head ?? "?")],
  ];
}

/** The record's match key, hiding the registry's snake_case field spelling. */
export function recordMatchKey(record: ExceptionRecord): string {
  return matchKey({
    fingerprint: record.fingerprint,
    suppressionType: record.suppression_type,
    rule: record.rule,
  });
}

/**
 * A record covers a head suppression only in its scoped file: canonical
 * identity (fingerprint + suppression type + rule) plus the record's `file`
 * scope. A lookalike suppression in another file finds no record and stays
 * unauthorized debt.
 */
function coversInScope(record: ExceptionRecord, h: ReconciledSuppression): boolean {
  return record.file === h.file && recordMatchKey(record) === matchKey(h);
}

export interface ExceptionCoverage {
  head: ReconciledSuppression[];
  statuses: Map<ExceptionRecord, ExceptionStatus>;
  counts: { used: number; expired: number; dangling: number; spent: number };
}

export interface CoverExceptionsInput {
  head: ReconciledSuppression[];
  records: ExceptionRecord[];
  now: Date;
}

/**
 * Authorize new/materially-changed debt against the registry and classify every
 * record's utilization. A record authorizes exactly the matching logical
 * suppression in its scoped file; a lookalike elsewhere is unauthorized debt
 * and leaves the record unused.
 */
export function coverExceptions(input: CoverExceptionsInput): ExceptionCoverage {
  const { head, records, now } = input;
  const statuses = new Map<ExceptionRecord, ExceptionStatus>();

  // Authorize new/materially-changed debt, or mark the record expired.
  // Authorization is file-scoped: a record covers only the matching
  // suppression in its own file, so a lookalike in another file finds no
  // record and is reported as unauthorized debt.
  const covered = head.map((h) => {
    if (h.disposition !== "new" && h.disposition !== "materially-changed") return h;
    const record = records.find((r) => coversInScope(r, h));
    if (!record) return h;
    if (isExpired(record.expires, now)) {
      statuses.set(record, "expired");
      return h;
    }
    statuses.set(record, "used");
    return {
      ...h,
      exception: {
        fingerprint: record.fingerprint,
        suppressionType: record.suppression_type,
        rule: record.rule,
      },
    };
  });

  // Classify the rest: expired is reported distinctly, then spent, then dangling.
  // Utilization is file-scoped: only a suppression in the record's own file can
  // spend it — a lookalike directive elsewhere never consumes the record.
  for (const record of records) {
    if (statuses.has(record)) continue;
    const matchesExistingInRecordFile = head.some(
      (h) =>
        (h.disposition === "existing" || h.disposition === "moved-existing") &&
        coversInScope(record, h),
    );
    if (isExpired(record.expires, now)) statuses.set(record, "expired");
    else if (matchesExistingInRecordFile) statuses.set(record, "spent");
    else statuses.set(record, "dangling");
  }

  const counts = { used: 0, expired: 0, dangling: 0, spent: 0 };
  for (const status of statuses.values()) counts[status]++;
  return { head: covered, statuses, counts };
}
