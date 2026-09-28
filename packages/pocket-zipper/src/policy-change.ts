import { canGuaranteePathApproval, viewPolicy } from "./policy.js";
import { recordMatchKey } from "./registry.js";
import type { ConfigSeverityLevel } from "./recognize.js";
import type { ExceptionRecord, Policy } from "./types.js";

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
  /**
   * The **baseline** policy, for the combined-landing opt-in. Read from the
   * baseline alone, which is what makes the opt-in baseline-gated: a head that
   * flips it on contributes nothing here, so enabling combined is itself a
   * protected policy change.
   */
  baselinePolicy: Policy;
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
  /**
   * The host's path-scoped approval on `.pocket-zipper/**` stands in for the
   * second PR: the whole delta is a new grant (so there is something to ride
   * along) and the **baseline** policy sanctions it. Read here, next to the
   * shape it qualifies, so "additive and nothing else" is stated once.
   */
  combined: boolean;
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
    baselinePolicy,
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
    return {
      weakening: false,
      failure: false,
      source: "none",
      registry,
      shape: "none",
      combined: false,
    };
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
  // The exception is the intersection of the shape and the baseline's own posture,
  // and the shape carries the whole "and nothing else": an `edit` never rides,
  // whatever the config says. The host half is `parsePolicy`'s own can-guarantee
  // rule, read rather than restated — a repo whose config is self-contradicting
  // never reaches this, because the baseline read throws first.
  const combined =
    shape === "additive" &&
    baselinePolicy.allowSameChangeExceptions &&
    canGuaranteePathApproval(baselinePolicy.host);
  // The host's path-scoped approval on `.pocket-zipper/**` stands in for the
  // second PR, so an excepted delta is not a failure and raises no signal: the
  // change carries its own record, and the approval being asked for is the very
  // approval covering the policy path. Both terms are answered together, so a
  // caller cannot read one and not the other.
  return {
    weakening: true,
    failure: !combined && consumedDebt > 0,
    source,
    registry,
    shape,
    combined,
  };
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
 *   with no unmatched baseline record to account for it.
 * - **`edit`** — such a key that an unmatched baseline record accounts for: the
 *   same debt, re-pointed. An identity edit always lands here.
 * - **`none`** — no new match key at all.
 *
 * The unit is the key *set*, not the record multiset: an appended record that
 * shares a key the baseline already carries (a twin) authorizes nothing new.
 * The two registries arrive as parsed records, so only well-formed registries
 * are ever compared here.
 *
 * A new slot may claim an unmatched baseline record in two ways, and the second
 * is why a rename is not a fresh grant:
 *
 * - **in the same file** — the pairing ticket 06 established, `file` being the
 *   one field neither in the match key nor moved by a field edit, so a removal
 *   and an addition in one file read as one record's history.
 * - **carrying the same match key, in any file** — `file` is part of the match
 *   (a record covers a suppression only in its scoped file), so a record
 *   repointed to a new file is the same debt at a new path, and is an identity
 *   edit. Read as an addition it would be eligible for a same-change exception
 *   under the combined-landing opt-in, which is how a renewal rode the additive
 *   path: repoint the record to the renamed file, extend its date, and the head
 *   record joined coverage with a date the change had just rewritten.
 *
 * Same-file claims are spent first, so every pairing that existed before the
 * second claim source is unchanged by it. `edit` wins over `additive` when a
 * delta carries both.
 */
function registryDelta(
  baseline: readonly ExceptionRecord[] | null,
  head: readonly ExceptionRecord[] | null,
): PolicyChangeShape {
  const baselineSlots = slotCounts(baseline);
  const headSlots = slotCounts(head);
  const newSlots = newSlotsOf(baselineSlots, headSlots);

  // The other half of the pairing: a baseline slot the head kept fewer records
  // for than it started with is a record the change left unmatched — the slot a
  // new grant may have been re-pointed into.
  const unpaired = new Map<string, number>();
  for (const [slot, count] of baselineSlots) {
    const left = count - (headSlots.get(slot) ?? 0);
    if (left > 0) unpaired.set(slot, left);
  }

  // `edits` is how far the new slots can be accounted for by the baseline
  // records the change left unmatched, and `additives` is what is left over.
  // An unmatched record is spent by the first new slot that claims it, so the
  // pool is drawn down as it is read — without that, two new slots in one file
  // would each claim the same unmatched record and a re-point would be counted
  // twice.
  let edits = 0;
  let additives = 0;
  for (const slot of newSlots) {
    const counted = headSlots.get(slot) ?? 0;
    const matched = claimUnpaired(unpaired, slot, counted);
    edits += matched;
    additives += counted - matched;
  }
  return edits > 0 ? "edit" : additives > 0 ? "additive" : "none";
}

/**
 * The head slots the baseline never carried, as `file` + match key: the
 * definition of a new grant. `registryDelta` reads it off the two slot maps it
 * has already built, and `sanctionedAdditions` off two fresh ones, so the rule
 * itself is stated once and the two cannot drift apart.
 */
function newSlotsOf(
  baselineSlots: ReadonlyMap<string, number>,
  headSlots: ReadonlyMap<string, number>,
): Set<string> {
  const slots = new Set<string>();
  for (const slot of headSlots.keys()) {
    if (!baselineSlots.has(slot)) slots.add(slot);
  }
  return slots;
}

/**
 * Spend up to `ceiling` of the unmatched records a new head slot can account
 * for, in the order `registryDelta` states: same file first, then the same match
 * key anywhere. Returns what it drew down, having already drawn it.
 *
 * The ceiling is the caller's own count for the slot, not the size of the pool,
 * so a slot never spends a record the caller does not credit it with. Draining
 * the whole pool instead would be a latent miscount rather than a live one — a
 * slot only matches when its own count is non-zero, so the two agree on every
 * verdict — but it would let one slot starve the next of a record it was
 * entitled to.
 */
function claimUnpaired(
  unpaired: Map<string, number>,
  slot: string,
  ceiling: number,
): number {
  const file = slotFile(slot);
  const key = slotMatchKey(slot);
  // The same-file pairing predates the cross-file claim, so no existing
  // behaviour depends on which pool a re-point was drawn from. A candidate
  // matching both is offered twice, which is what the two passes it replaces
  // did: the second pass revisited whatever the first left standing.
  const order: string[] = [];
  for (const [candidate, count] of unpaired) {
    if (count > 0 && slotFile(candidate) === file) order.push(candidate);
  }
  for (const [candidate, count] of unpaired) {
    if (count > 0 && slotMatchKey(candidate) === key) order.push(candidate);
  }
  let claimed = 0;
  for (const candidate of order) {
    if (claimed >= ceiling) break;
    const count = unpaired.get(candidate) ?? 0;
    if (count <= 0) continue;
    const taken = Math.min(count, ceiling - claimed);
    unpaired.set(candidate, count - taken);
    claimed += taken;
  }
  return claimed;
}

/**
 * The head records a new grant brought, in registry order — the coverage union
 * the same-change exception authorizes debt against. It is the same rule
 * `registryDelta` reads: head slots the baseline never carried. Under the same-change exception
 * there are no edits by construction, so "every record in a new slot" and "every
 * addition" are one set, and no second accounting rule can disagree.
 */
export function sanctionedAdditions(
  baseline: readonly ExceptionRecord[] | null,
  head: readonly ExceptionRecord[] | null,
): ExceptionRecord[] {
  const slots = newSlotsOf(slotCounts(baseline), slotCounts(head));
  return (head ?? []).filter((record) => slots.has(slotKeyOf(record)));
}

/** The separator a slot key is built on; git paths cannot contain it. */
const SLOT_SEPARATOR = "\u0000";

/** One registry's slots, each counted — `(file, match key)` is the allocation's unit. */
function slotCounts(records: readonly ExceptionRecord[] | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records ?? []) {
    const key = slotKeyOf(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function slotKeyOf(record: ExceptionRecord): string {
  return `${record.file}${SLOT_SEPARATOR}${recordMatchKey(record)}`;
}

/** The file half of a slot key, recovered by the separator it was built on. */
function slotFile(slot: string): string {
  return slot.slice(0, slot.indexOf(SLOT_SEPARATOR));
}

/** The match-key half of a slot key — the identity a re-point across files keeps. */
function slotMatchKey(slot: string): string {
  return slot.slice(slot.indexOf(SLOT_SEPARATOR) + 1);
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
