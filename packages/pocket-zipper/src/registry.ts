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
  const owner = requireString(obj, "owner", where);
  const reference = requireString(obj, "reference", where);

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

  return {
    rule,
    suppression_type: suppressionType,
    fingerprint,
    file,
    type,
    reason,
    owner,
    reference,
    ...(expires ? { expires } : {}),
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
export function remediationFields(entry: InventoryEntry): Array<[string, string]> {
  return [
    ["rule", entry.rule],
    ["suppression_type", entry.suppressionType],
    ["fingerprint", entry.fingerprint],
    ["file", entry.file],
    ["type", "temporary"],
    ["reason", "<why this suppression is necessary>"],
    ["owner", "<owning team>"],
    ["reference", "<issue or PR link>"],
    ["expires", "<YYYY-MM-DD>"],
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
