import { viewPolicy } from "./policy.js";
import { recordMatchKey } from "./registry.js";
import type { ConfigSeverityLevel } from "./recognize.js";
import type { ExceptionRecord } from "./types.js";

export interface PolicyChangeInput {
  baselineConfig: string | null;
  headConfig: string | null;
  /** The baseline registry, as parsed records; null when the baseline carries none. */
  baselineRegistry: readonly ExceptionRecord[] | null;
  /** The registry the change proposes, as parsed records; null when the head carries none. */
  headRegistry: readonly ExceptionRecord[] | null;
  /** Whether the proposed change touched one of the two `.pocket-zipper` files. */
  protectedTouched: boolean;
  /** Rules governed under the baseline policy — used to judge allowlist narrowing. */
  baselineGoverned: string[];
  /** New or materially-changed governed debt introduced by the same change. */
  consumedDebt: number;
  /** Effective severity bands in the flat config, per tree (see `configSeverityLevels`). */
  baselineLevels: ConfigSeverityLevel[];
  headLevels: ConfigSeverityLevel[];
}

export type PolicyChangeSource = "protected" | "eslint-config" | "both" | "none";

export type PolicyChangeShape = "none" | "additive" | "edit";

export interface PolicyChangeResult {
  weakening: boolean;
  failure: boolean;
  /** Which surface weakened, for a truthful error message. */
  source: PolicyChangeSource;
  /** How the exception registry itself changed. */
  registry: PolicyChangeShape;
  /**
   * The whole delta's shape. `additive` only when a new grant is the *sole*
   * weakening; every other weakening is an `edit`.
   */
  shape: PolicyChangeShape;
}

/**
 * The self-authorization rule: a weakening delta (to the protected
 * `.pocket-zipper` files or to the ESLint flat config's own rule severities)
 * that is consumed by new debt in the same change fails the gate. Pure:
 * callers supply the two documents and the two registries from each tree, so
 * every read that feeds the judgement happens before this function runs.
 */
export function detectPolicyChange(input: PolicyChangeInput): PolicyChangeResult {
  const {
    baselineConfig,
    headConfig,
    baselineRegistry,
    headRegistry,
    protectedTouched,
    baselineGoverned,
    consumedDebt,
    baselineLevels,
    headLevels,
  } = input;

  // The trigger: a protected file the change does not touch is not part of the
  // change. It governs *both* `.pocket-zipper` surfaces, and it has to gate the
  // config one explicitly rather than lean on the two documents reading alike:
  // `readHeadContent` falls back to the worktree when the index cannot be read,
  // so an unstaged `config.yml` the change never carried is a head document
  // here, and comparing it would judge a file outside the change. The ESLint
  // flat config's own severities are the same policy change however the change
  // is spelled, so `configSeverityWeakened` keeps its own structural gate.
  const registry = protectedTouched ? registryDelta(baselineRegistry, headRegistry) : "none";
  const configWeakenedHere =
    protectedTouched && configWeakened(baselineConfig, headConfig, baselineGoverned);
  const protectedWeakened = configWeakenedHere || registry !== "none";
  const eslintWeakened = configSeverityWeakened(baselineLevels, headLevels, baselineGoverned);

  const weakening = protectedWeakened || eslintWeakened;
  if (!weakening) {
    return { weakening: false, failure: false, source: "none", registry, shape: "none" };
  }

  const source: PolicyChangeSource =
    protectedWeakened && eslintWeakened
      ? "both"
      : eslintWeakened
        ? "eslint-config"
        : "protected";

  // `additive` is the sole-weakening shape: a new grant beside a config or
  // severity weakening is a combined PR, and reads as an `edit` whatever the
  // registry alone would say.
  const shape: PolicyChangeShape =
    registry === "additive" && !configWeakenedHere && !eslintWeakened ? "additive" : "edit";
  return { weakening: true, failure: consumedDebt > 0, source, registry, shape };
}

function configWeakened(
  baselineRaw: string | null,
  headRaw: string | null,
  baselineGoverned: string[],
): boolean {
  const base = viewPolicy(baselineRaw);
  const head = viewPolicy(headRaw);
  // `enabled` flips true -> false, or is removed while the baseline declared it true.
  if (base.enabled && (!head.enabled || (base.enabledPresent && !head.enabledPresent))) {
    return true;
  }
  if (base.governedRules === null && head.governedRules !== null) {
    // Introducing an allowlist only weakens if it drops a rule the baseline
    // actually governed; a list covering every governed rule changes nothing.
    const headSet = new Set(head.governedRules);
    if (baselineGoverned.some((r) => !headSet.has(r))) return true;
  }
  if (base.governedRules !== null && head.governedRules !== null) {
    const headSet = new Set(head.governedRules);
    if (base.governedRules.some((r) => !headSet.has(r))) return true;
  }
  return false;
}

/**
 * How the registry itself changed, as the match-key set rather than the record
 * multiset. A record's scope is its file, so the two sides are compared per
 * `(file, match key)`:
 *
 * - **`additive`** — a match key present in the head and absent at baseline,
 *   with no unmatched baseline record in the same file to account for it.
 * - **`edit`** — such a key whose file holds an unmatched baseline record: the
 *   same slot, re-pointed. An identity edit always lands here.
 * - **`none`** — no new match key at all.
 *
 * The unit is the key *set*, not the record multiset: an appended record that
 * shares a key the baseline already carries (a twin) authorizes nothing new.
 * Pairing is by `file` alone — the one field neither in the match key nor moved
 * by an edit — so a removal and an addition in one file read as one record's
 * history, and `edit` wins over `additive` when a delta carries both. The two
 * registries arrive as parsed records, so only well-formed registries are ever
 * compared here.
 */
function registryDelta(
  baseline: readonly ExceptionRecord[] | null,
  head: readonly ExceptionRecord[] | null,
): PolicyChangeShape {
  const baselineSlots = slotCounts(baseline);
  const headSlots = slotCounts(head);

  // A key the baseline never carried in that file authorizes something new; a
  // key it did carry authorizes nothing new however many records repeat it.
  const newKeys = new Set<string>();
  for (const key of headSlots.keys()) {
    if (!baselineSlots.has(key)) newKeys.add(key);
  }
  // The other half of the pairing: a baseline slot the head kept fewer records
  // for than it started with is a record the change left unmatched — the slot a
  // new grant in the same file may have been re-pointed into.
  const unpairedByFile = new Map<string, number>();
  for (const [key, count] of baselineSlots) {
    const kept = headSlots.get(key) ?? 0;
    if (count > kept) {
      const file = slotFile(key);
      unpairedByFile.set(file, (unpairedByFile.get(file) ?? 0) + (count - kept));
    }
  }

  // Per file, `edits` is how far the new keys can be accounted for by the
  // baseline records the change left unmatched and `additives` is what is left
  // over: `min(new keys, unpaired)`. An unmatched record is spent by the first
  // new key that claims it, so the pool is drawn down as it is read — without
  // that, two new keys in one file would each claim the same unmatched record
  // and a re-point would be counted twice.
  let edits = 0;
  let additives = 0;
  for (const key of newKeys) {
    const file = slotFile(key);
    const counted = headSlots.get(key) ?? 0;
    const unpaired = unpairedByFile.get(file) ?? 0;
    const matched = Math.min(counted, unpaired);
    unpairedByFile.set(file, unpaired - matched);
    edits += matched;
    additives += counted - matched;
  }
  return edits > 0 ? "edit" : additives > 0 ? "additive" : "none";
}

/** The separator a slot key is built on; git paths cannot contain it. */
const SLOT_SEPARATOR = "\u0000";

/** One registry's slots, each counted — `(file, match key)` is the allocation's unit. */
function slotCounts(records: readonly ExceptionRecord[] | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records ?? []) {
    const key = `${record.file}${SLOT_SEPARATOR}${recordMatchKey(record)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The file half of a slot key, recovered by the separator it was built on. */
function slotFile(slot: string): string {
  return slot.slice(0, slot.indexOf(SLOT_SEPARATOR));
}

/**
 * A governed rule whose *effective* severity drops in the head's flat config is
 * a weakening of the governed surface — whether it falls off/warn/error, and
 * whether via a global or scoped declaration. Turning off a rule the allowlist
 * never governed changes nothing, so only baseline-governed rules count.
 *
 * Effective bands are compared per scope, with a global band standing in for
 * every scope that has no declaration of its own: "this rule is error here,
 * warn there, off everywhere the config does not mention it".
 */
function configSeverityWeakened(
  baselineLevels: ConfigSeverityLevel[],
  headLevels: ConfigSeverityLevel[],
  baselineGoverned: string[],
): boolean {
  const governed = new Set(baselineGoverned);
  const baselineByRule = new Map<string, ConfigSeverityLevel[]>();
  for (const l of baselineLevels) {
    const list = baselineByRule.get(l.rule);
    if (list) list.push(l);
    else baselineByRule.set(l.rule, [l]);
  }
  const headByRule = new Map<string, ConfigSeverityLevel[]>();
  for (const l of headLevels) {
    const list = headByRule.get(l.rule);
    if (list) list.push(l);
    else headByRule.set(l.rule, [l]);
  }

  const globalBand = (levels: ConfigSeverityLevel[]): number | undefined =>
    levels.find((l) => l.files === null)?.band;

  for (const rule of governed) {
    const base = baselineByRule.get(rule) ?? [];
    const head = headByRule.get(rule) ?? [];
    const baseGlobal = globalBand(base);
    const headGlobal = globalBand(head);

    // The global span: a rule's catch-all severity, and the fallback for any
    // scope without a declaration of its own on either side.
    if (baseGlobal !== undefined && headGlobal !== undefined && headGlobal < baseGlobal) {
      return true;
    }

    // Honed scopes: compare each scope name the two trees disagree about,
    // letting each side's global band speak for unnamed scopes.
    const scopes = new Set<string>();
    for (const l of base) scopes.add(spanKey(l));
    for (const l of head) scopes.add(spanKey(l));
    for (const key of scopes) {
      const baseBand = base.find((l) => spanKey(l) === key)?.band ?? baseGlobal;
      const headBand = head.find((l) => spanKey(l) === key)?.band ?? headGlobal;
      if (baseBand !== undefined && headBand !== undefined && headBand < baseBand) {
        return true;
      }
    }
  }
  return false;
}

function spanKey(level: ConfigSeverityLevel): string {
  return JSON.stringify({
    files: level.files ? [...level.files].map((s) => s.trim()).sort() : level.files,
    ignores: level.ignores ? [...level.ignores].map((s) => s.trim()).sort() : level.ignores,
  });
}
