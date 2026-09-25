import { matchKey } from "./identity.js";
import type {
  ExceptionRecord,
  ExceptionStatus,
  InventoryEntry,
  ReconciledSuppression,
} from "./types.js";

/**
 * The registry's semantics: what a record means once it is a valid instance of
 * the format. The format itself — the field grammar, the enum and date rules,
 * and the diagnostics — belongs to the shared validator, which every read of
 * these files goes through.
 */
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
 * suppression, with placeholders for the human-authored ones and the
 * evaluation's suggested expiry. The one place the record's field *order* is
 * spelled for a human; `KNOWN_FIELDS` is the same order, and a test pins the
 * two together. A record's own optional fields stay optional here: the `line`
 * row appears only when the inventory knows the directive's line, so the
 * template never prints a value the loader would reject.
 */
export function remediationFields(
  entry: InventoryEntry,
  suggestedExpiry?: string,
): Array<[string, string]> {
  const fields: Array<[string, string]> = [
    ["rule", entry.rule],
    ["suppression_type", entry.suppressionType],
    ["fingerprint", entry.fingerprint],
    ["file", entry.file],
    ["type", "temporary"],
    ["reason", "<why this suppression is necessary>"],
    ["reference", "<issue or PR link>"],
    ["expires", suggestedExpiry ?? "<YYYY-MM-DD>"],
  ];
  if (entry.lines.head !== null) fields.push(["line", String(entry.lines.head)]);
  return fields;
}

/**
 * The record's match key, hiding the registry's snake_case field spelling. It is
 * record *semantics* — what a record is matched on — not part of the format
 * grammar, so it lives here beside the reader that uses it.
 */
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
