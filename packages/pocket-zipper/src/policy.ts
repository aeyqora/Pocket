import { parse as parseYaml } from "yaml";
import { configError } from "./errors.js";
import type { DurationLiteral, Host, Policy } from "./types.js";

export const DEFAULT_EXPIRY = "30d" as const;
export const DEFAULT_MAX_EXPIRY = "3mo" as const;

export const DEFAULT_POLICY: Policy = {
  enabled: true,
  governedRules: null,
  exceptions: { defaultExpiry: DEFAULT_EXPIRY, maxExpiry: DEFAULT_MAX_EXPIRY },
  allowSameChangeExceptions: false,
  host: null,
};

/** A positive integer plus `d` (days) or `mo` (months), strict lowercase. */
const DURATION_RE = /^(\d+)(d|mo)$/;

export const HOSTS: readonly Host[] = [
  "github",
  "gitlab-premium",
  "gitlab-free",
  "bitbucket-cloud",
  "bitbucket-server",
];

/** Top-level keys the policy document may carry; anything else is rejected. */
const KNOWN_KEYS = new Set([
  "enabled",
  "governedRules",
  "exceptions",
  "allowSameChangeExceptions",
  "host",
]);

/** Keys inside the `exceptions:` stanza; anything else is rejected. */
const KNOWN_EXCEPTION_KEYS = new Set(["defaultExpiry", "maxExpiry"]);

export function isDurationLiteral(value: unknown): value is DurationLiteral {
  return typeof value === "string" && DURATION_RE.test(value);
}

/**
 * Tolerant, non-throwing view of a policy document. Shared by strict validation
 * (`parsePolicy`) and policy-change detection so the extraction lives once.
 * Bad documents are never thrown from here: each condition is surfaced as a
 * flag or a captured value for `parsePolicy` to turn into a named error.
 */
export interface ExceptionsView {
  /** Present with at least one declared key (empty/absent → fallbacks). */
  present: boolean;
  /** Present but not a mapping. */
  shapeInvalid: boolean;
  /** Declared literal when declared-and-valid, else null. */
  defaultExpiry: DurationLiteral | null;
  maxExpiry: DurationLiteral | null;
  /** True when the key is absent or a valid literal. */
  defaultExpiryValid: boolean;
  maxExpiryValid: boolean;
  /** Keys inside the stanza that are neither `defaultExpiry` nor `maxExpiry`. */
  unknownKeys: string[];
}

export interface PolicyView {
  enabled: boolean;
  enabledPresent: boolean;
  enabledValid: boolean;
  governedRules: string[] | null;
  governedRulesValid: boolean;
  exceptions: ExceptionsView;
  /** Top-level keys the policy document may not carry. */
  topLevelUnknown: string[];
  allowSameChangeExceptions: boolean;
  allowSameChangeValid: boolean;
  host: Host | null;
  hostValid: boolean;
  malformed: boolean;
}

const EMPTY_EXCEPTIONS: ExceptionsView = {
  present: false,
  shapeInvalid: false,
  defaultExpiry: null,
  maxExpiry: null,
  defaultExpiryValid: true,
  maxExpiryValid: true,
  unknownKeys: [],
};

function emptyView(): PolicyView {
  return {
    enabled: true,
    enabledPresent: false,
    enabledValid: true,
    governedRules: null,
    governedRulesValid: true,
    exceptions: { ...EMPTY_EXCEPTIONS },
    topLevelUnknown: [],
    allowSameChangeExceptions: false,
    allowSameChangeValid: true,
    host: null,
    hostValid: true,
    malformed: false,
  };
}

export function viewPolicy(raw: string | null): PolicyView {
  const base = emptyView();
  if (raw === null || raw.trim().length === 0) return base;
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    return { ...base, malformed: true };
  }
  if (doc === null || doc === undefined) return base;
  if (typeof doc !== "object" || Array.isArray(doc)) return { ...base, malformed: true };
  const obj = doc as Record<string, unknown>;

  const enabledRaw = obj["enabled"];
  const enabledPresent = enabledRaw !== undefined;
  const enabledValid = enabledRaw === undefined || typeof enabledRaw === "boolean";
  const enabled = typeof enabledRaw === "boolean" ? enabledRaw : true;

  const rulesRaw = obj["governedRules"];
  let governedRules: string[] | null = null;
  let governedRulesValid = true;
  if (rulesRaw !== undefined && rulesRaw !== null) {
    if (
      !Array.isArray(rulesRaw) ||
      rulesRaw.some((r) => typeof r !== "string" || r.trim().length === 0)
    ) {
      governedRulesValid = false;
    } else {
      governedRules = rulesRaw as string[];
    }
  }

  const topLevelUnknown = Object.keys(obj).filter((k) => !KNOWN_KEYS.has(k));

  const sameRaw = obj["allowSameChangeExceptions"];
  const allowSameChangeValid = sameRaw === undefined || typeof sameRaw === "boolean";
  const allowSameChangeExceptions = typeof sameRaw === "boolean" ? sameRaw : false;

  const hostRaw = obj["host"];
  const hostValid = hostRaw === undefined || hostRaw === null || HOSTS.includes(hostRaw as Host);
  const host = hostValid ? ((hostRaw as Host | undefined) ?? null) : null;

  return {
    enabled,
    enabledPresent,
    enabledValid,
    governedRules,
    governedRulesValid,
    exceptions: parseExceptions(obj["exceptions"]),
    topLevelUnknown,
    allowSameChangeExceptions,
    allowSameChangeValid,
    host,
    hostValid,
    malformed: false,
  };
}

function parseExceptions(raw: unknown): ExceptionsView {
  if (raw === undefined || raw === null || raw === "") return { ...EMPTY_EXCEPTIONS };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ...EMPTY_EXCEPTIONS, present: true, shapeInvalid: true };
  }
  const exc = raw as Record<string, unknown>;
  const keys = Object.keys(exc);
  if (keys.length === 0) return { ...EMPTY_EXCEPTIONS };

  const unknownKeys = keys.filter((k) => !KNOWN_EXCEPTION_KEYS.has(k));

  const defaultRaw = exc["defaultExpiry"];
  const defaultExpiryValid = defaultRaw === undefined || isDurationLiteral(defaultRaw);
  const defaultExpiry = isDurationLiteral(defaultRaw) ? defaultRaw : null;

  const maxRaw = exc["maxExpiry"];
  const maxExpiryValid = maxRaw === undefined || isDurationLiteral(maxRaw);
  const maxExpiry = isDurationLiteral(maxRaw) ? maxRaw : null;

  return {
    present: true,
    shapeInvalid: false,
    defaultExpiry,
    maxExpiry,
    defaultExpiryValid,
    maxExpiryValid,
    unknownKeys,
  };
}

/**
 * Canonical day count for ordering `defaultExpiry` against `maxExpiry`.
 * Months are read as a flat 30 days. A static comparison of "N months" vs
 * "M days" has to pick a month length because calendar months vary (28–31
 * days); 30 is the documented canonical choice. This is deliberately a
 * coarse sanity net that flags obvious self-contradictions only — the
 * date-exact ceiling (clamped, via `addDuration`) is enforced at
 * authoring/evaluation time (EXPIRY_POLICY, ticket 05), not here.
 */
function durationDays(literal: DurationLiteral): number {
  const match = DURATION_RE.exec(literal)!;
  const n = Number(match[1]);
  return match[2] === "mo" ? n * 30 : n;
}

function durationError(key: string): string {
  return `.pocket-zipper/config.yml: '${key}' is not a duration literal — a positive integer plus 'd' (days) or 'mo' (months), strict lowercase (e.g. 30d, 3mo)`;
}

export function parsePolicy(raw: string | null, knownRules: Set<string>): Policy {
  const view = viewPolicy(raw);
  if (view.malformed) throw configError("malformed .pocket-zipper/config.yml");
  if (!view.enabledValid) {
    throw configError(".pocket-zipper/config.yml: 'enabled' must be a boolean");
  }
  if (view.topLevelUnknown.length > 0) {
    const names = view.topLevelUnknown.map((k) => `'${k}'`).join(", ");
    throw configError(
      `.pocket-zipper/config.yml: unknown key${view.topLevelUnknown.length > 1 ? "s" : ""} ${names}`,
    );
  }

  const exc = view.exceptions;
  if (exc.shapeInvalid) {
    throw configError(
      ".pocket-zipper/config.yml: 'exceptions' must be a mapping of 'defaultExpiry' and 'maxExpiry'",
    );
  }
  if (exc.unknownKeys.length > 0) {
    const names = exc.unknownKeys.map((k) => `'exceptions.${k}'`).join(", ");
    throw configError(
      `.pocket-zipper/config.yml: unknown key${exc.unknownKeys.length > 1 ? "s" : ""} ${names} inside 'exceptions'`,
    );
  }
  if (!exc.defaultExpiryValid) throw configError(durationError("exceptions.defaultExpiry"));
  if (!exc.maxExpiryValid) throw configError(durationError("exceptions.maxExpiry"));

  if (!view.governedRulesValid) {
    throw configError(
      ".pocket-zipper/config.yml: 'governedRules' must be a list of non-empty strings",
    );
  }
  if (!view.allowSameChangeValid) {
    throw configError(".pocket-zipper/config.yml: 'allowSameChangeExceptions' must be a boolean");
  }
  if (!view.hostValid) {
    throw configError(`.pocket-zipper/config.yml: 'host' must be one of: ${HOSTS.join(", ")}`);
  }

  const exceptions: Policy["exceptions"] = {
    defaultExpiry: exc.defaultExpiry ?? DEFAULT_EXPIRY,
    maxExpiry: exc.maxExpiry ?? DEFAULT_MAX_EXPIRY,
  };
  if (durationDays(exceptions.defaultExpiry) > durationDays(exceptions.maxExpiry)) {
    throw configError(
      `.pocket-zipper/config.yml: 'defaultExpiry' (${exceptions.defaultExpiry}) exceeds 'maxExpiry' (${exceptions.maxExpiry}) — the policy can't contradict itself`,
    );
  }

  // Structural checks run even when the gate is off; only the ESLint-dependent
  // allowlist-rule check keeps requiring the gate.
  if (view.enabled && view.governedRules !== null && knownRules.size > 0) {
    for (const entry of view.governedRules) {
      if (!knownRules.has(entry)) {
        throw configError(
          `.pocket-zipper/config.yml: governedRules names an unrecognized ESLint rule '${entry}'`,
        );
      }
    }
  }

  return {
    enabled: view.enabled,
    governedRules: view.governedRules,
    exceptions,
    allowSameChangeExceptions: view.allowSameChangeExceptions,
    host: view.host,
  };
}

/**
 * Resolve a duration literal against a YYYY-MM-DD start, returning the
 * resulting YYYY-MM-DD. Days are exact; calendar months clamp to month end
 * (May 31 + 1mo → Jun 30). The authoring surface uses this to prefill
 * `expires = today + defaultExpiry`; the expiry checks resolve `maxExpiry`
 * against the current date the same way.
 */
export function addDuration(isoDate: string, literal: DurationLiteral): string {
  const [year, month, day] = isoDate.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const value = Number(DURATION_RE.exec(literal)![1]);
  const target = literal.endsWith("mo")
    ? addCalendarMonths(year, month, day, value)
    : addDays(year, month, day, value);
  return formatIso(target);
}

function addDays(year: number, month: number, day: number, days: number): Date {
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt;
}

function addCalendarMonths(year: number, month: number, day: number, months: number): Date {
  const monthIndex = month - 1 + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDayOfTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDayOfTarget)));
}

function formatIso(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The concrete `expires` date an authoring surface prefills: the evaluation's
 * UTC date plus the policy's `defaultExpiry`. It is a suggestion, never a
 * constraint — the author may pick another date, and the ceiling that actually
 * binds is `maxExpiry` (ticket 05).
 */
export function suggestedExpiry(now: Date, defaultExpiry: DurationLiteral): string {
  return addDuration(formatIso(now), defaultExpiry);
}

export function computeGovernedSet(
  policy: Policy,
  applicable: Iterable<string>,
): string[] {
  const applicableSet = new Set(applicable);
  if (policy.governedRules === null) {
    return [...applicableSet].sort();
  }
  const out = policy.governedRules.filter((r) => applicableSet.has(r));
  out.sort();
  return out;
}
