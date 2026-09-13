import { parse as parseYaml } from "yaml";
import { configError } from "./errors.js";
import type { ExceptionRecord, SuppressionType } from "./types.js";

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
    throw configError("malformed .pocket-lock/exceptions.yml", String(err));
  }
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) {
    throw configError(".pocket-lock/exceptions.yml must be a list of records");
  }
  return doc.map((entry, index) => validateRecord(entry, index));
}

function validateRecord(entry: unknown, index: number): ExceptionRecord {
  const where = `.pocket-lock/exceptions.yml[${index}]`;
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
