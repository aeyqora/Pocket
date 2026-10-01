import { parse as parseYaml } from "yaml";
import { configError } from "./errors.js";
import type { DurationLiteral, Host, Policy, SeverityBand } from "./types.js";

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

/**
 * The hosts that can guarantee a **distinct, path-scoped approval** for
 * `.pocket-zipper/**` — the layer combined landing substitutes for the second
 * protected PR. GitHub's rulesets and required-CODEOWNERS reviews, and GitLab
 * Premium's enforced approval rules, are the two that can make "a different
 * human approved this path" a fact the host will not let a PR skip. Everything
 * else in the value space either has no such layer or has one that only warns,
 * which is precisely the fail-open the opt-in refuses to buy.
 */
export const CAN_GUARANTEE_HOSTS: readonly Host[] = ["github", "gitlab-premium"];

/** Whether a declared host can guarantee the distinct path approval the opt-in relies on. */
export function canGuaranteePathApproval(host: Host | null): boolean {
  return host !== null && CAN_GUARANTEE_HOSTS.includes(host);
}

/** Top-level keys the policy document may carry; anything else is rejected. */
const KNOWN_KEYS = new Set([
  "enabled",
  "governedRules",
  "minSeverities",
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
 * The literal spelled for a transcript — `30d` as "30 days", `2mo` as
 * "2 months" — the one place the authoring surface's "(N days from today)"
 * parenthetical is derived, so it can never disagree with the policy's own
 * grammar.
 */
export function describeDuration(literal: DurationLiteral): string {
  const match = DURATION_RE.exec(literal)!;
  const n = Number(match[1]);
  const unit = match[2] === "mo" ? "month" : "day";
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
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
  minSeverities: Record<string, SeverityBand> | null;
  minSeveritiesValid: boolean;
  minSeveritiesInvalidKeys: string[];
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
    minSeverities: null,
    minSeveritiesValid: true,
    minSeveritiesInvalidKeys: [],
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

  const floorsRaw = obj["minSeverities"];
  let minSeverities: Record<string, SeverityBand> | null = null;
  let minSeveritiesValid = true;
  const minSeveritiesInvalidKeys: string[] = [];
  if (floorsRaw !== undefined && floorsRaw !== null) {
    if (typeof floorsRaw !== "object" || Array.isArray(floorsRaw)) {
      minSeveritiesValid = false;
    } else {
      const parsed: Record<string, SeverityBand> = {};
      for (const [rule, floor] of Object.entries(floorsRaw as Record<string, unknown>)) {
        if (rule.trim().length === 0 || !isSeverityBand(floor)) {
          minSeveritiesValid = false;
          minSeveritiesInvalidKeys.push(rule);
        } else {
          parsed[rule] = floor;
        }
      }
      minSeverities = parsed;
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
    minSeverities,
    minSeveritiesValid,
    minSeveritiesInvalidKeys,
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
  if (!view.minSeveritiesValid) {
    const invalidKeys = view.minSeveritiesInvalidKeys.filter((key) => key.length > 0);
    if (invalidKeys.length > 0) {
      const names = invalidKeys.map((key) => `'minSeverities.${key}'`).join(", ");
      throw configError(
        `.pocket-zipper/config.yml: ${names} must be one of 'off', 'warn', or 'error'`,
      );
    }
    throw configError(
      ".pocket-zipper/config.yml: 'minSeverities' must be a mapping of rule ids to 'off', 'warn', or 'error'; every rule key must name a valid severity band",
    );
  }
  if (!view.allowSameChangeValid) {
    throw configError(".pocket-zipper/config.yml: 'allowSameChangeExceptions' must be a boolean");
  }
  if (!view.hostValid) {
    throw configError(`.pocket-zipper/config.yml: 'host' must be one of: ${HOSTS.join(", ")}`);
  }
  // The pair is one setting, not two. Combined landing trades the second
  // protected PR for the host's own path-scoped approval on `.pocket-zipper/**`,
  // so a host that cannot guarantee one makes the trade a silent fail-open — the
  // path would get no distinct approval and nothing in the tool would say so.
  // A self-contradicting config cannot opt in: the repository stays two-step.
  if (view.allowSameChangeExceptions && !canGuaranteePathApproval(view.host)) {
    const values = CAN_GUARANTEE_HOSTS.map((h) => `'${h}'`).join(" or ");
    throw configError(
      `.pocket-zipper/config.yml: 'allowSameChangeExceptions' requires a 'host' that can guarantee a distinct, path-scoped approval for .pocket-zipper/** (${values}) — the opt-in substitutes that approval for the second protected PR, and a host that cannot guarantee it would leave the policy path unowned by anyone in particular; this config is self-contradicting, so the repository stays on the two-step landing`,
    );
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
    ...(view.minSeverities === null ? {} : { minSeverities: view.minSeverities }),
    exceptions,
    allowSameChangeExceptions: view.allowSameChangeExceptions,
    host: view.host,
  };
}

function isSeverityBand(value: unknown): value is SeverityBand {
  return value === "off" || value === "warn" || value === "error";
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
  return isoDay(target);
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

/**
 * A date's UTC day as YYYY-MM-DD — the one spelling of "today" the expiry
 * arithmetic and the authoring surface share, so a prefilled date and the day
 * it was prefilled on can never disagree.
 */
export function isoDay(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Whole days from one ISO date to another — negative when `to` is the earlier
 * date. The one spelling of "how far apart are these two dates", so a surface
 * that reports a horizon as a day count (the wizard's renewal list) and the
 * arithmetic that produced the date itself cannot disagree about it. Midnight
 * UTC on both sides, so a DST transition in the viewer's own zone cannot move
 * the count; the arithmetic is whole days by construction, hence the rounding.
 */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * The date a duration literal lands on from `now`'s UTC date — the one spelling
 * of the "today plus a literal" arithmetic, so the authoring surface's prefill
 * and the expiry-horizon check can never disagree about a date.
 */
export function expiryHorizon(now: Date, literal: DurationLiteral): string {
  return addDuration(isoDay(now), literal);
}

/**
 * The concrete `expires` date an authoring surface prefills: the evaluation's
 * UTC date plus the policy's `defaultExpiry`. It is a suggestion, never a
 * constraint — the author may pick another date, and the ceiling that actually
 * binds is `maxExpiry` (ticket 05).
 */
export function suggestedExpiry(now: Date, defaultExpiry: DurationLiteral): string {
  return expiryHorizon(now, defaultExpiry);
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
