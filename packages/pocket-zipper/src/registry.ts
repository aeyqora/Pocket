import { matchKey } from "./identity.js";
import { expiryHorizon } from "./policy.js";
import type {
  DurationLiteral,
  ExceptionRecord,
  ExceptionStatus,
  InventoryEntry,
  LogicalSuppression,
  PoolCount,
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
 * The one statement of "this record's date runs past the ceiling": a defined
 * `expires` strictly after the horizon the policy allows. Stated here, beside
 * `isExpired`, because three surfaces answer the same question about the same
 * records and must not drift — `validate`'s `OVERLONG_EXCEPTION` finding, the
 * report's overlong count, and the head-side refusal below. The horizon itself
 * is `expiryHorizon(now, maxExpiry)`, so no caller re-derives the arithmetic.
 */
export function isOverlong(record: ExceptionRecord, horizon: string): boolean {
  return record.expires !== undefined && record.expires > horizon;
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
 * unauthorized debt. This states the same scope rule the allocator states as a
 * pool key, so the two have to move together.
 */
function coversInScope(record: ExceptionRecord, h: ReconciledSuppression): boolean {
  return record.file === h.file && recordMatchKey(record) === matchKey(h);
}

/**
 * The pool's arithmetic as one sentence. Written once, here, because the human
 * report and `validate`'s `POOL_COUNTS` finding are two answers to the same
 * question and a reader who gets different numbers from each is worse off than
 * a reader who gets none.
 */
export function poolCountLine(pool: PoolCount): string {
  return `For this rule at this file: ${pool.matched} matching records, ${pool.used} used, ${pool.leftover} leftover`;
}

/** One record authorizing one suppression: the whole content of the pairing. */
export interface ExceptionPair {
  readonly record: ExceptionRecord;
  readonly suppression: LogicalSuppression;
}

/**
 * A record no suppression was left for, with the pool it sits in and the record
 * that reserved that pool's first slot. `reserved` is the only record a renewal
 * accusation has a meaning against: a twin pool is *required* to hold records
 * with different horizons, because they authorize different suppressions.
 */
export interface UnclaimedRecord {
  readonly record: ExceptionRecord;
  /** The `(rule, file)` arithmetic this record's pool is reported under. */
  readonly pool: PoolCount;
  readonly reserved: ExceptionRecord | null;
}

export interface ExceptionAllocation {
  /** Who authorized whom, in registry order. */
  readonly pairs: ExceptionPair[];
  /** The `(rule, file)` arithmetic, ordered by rule then file. */
  readonly pools: PoolCount[];
  /** Every record left over, in registry order. */
  readonly unclaimed: UnclaimedRecord[];
}

export interface AllocateExceptionsInput<S extends LogicalSuppression = LogicalSuppression> {
  records: readonly ExceptionRecord[];
  /** The suppressions available to be authorized, in the caller's own order. */
  suppressions: readonly S[];
  now: Date;
  /**
   * May this suppression be claimed at all? New or materially-changed debt in an
   * evaluation; every live suppression in a working-tree lint, which has no
   * baseline to be relative to. This predicate is the *only* thing two callers
   * disagree about — classification stays with the caller. It is typed over the
   * caller's own suppression so each can ask its own question without a cast.
   */
  claimable: (suppression: S) => boolean;
}

/** One `(file, match key)` pool's mutable bookkeeping, internal to the allocator. */
interface Pool {
  readonly file: string;
  readonly rule: string;
  /** Claimable suppressions not yet reserved, in the order supplied. */
  readonly slots: LogicalSuppression[];
  /** Records that could reserve a slot, expired ones excluded. */
  matched: number;
  used: number;
  /** The first record that reserved a slot — this pool's reference record. */
  reserved: ExceptionRecord | null;
}

/** The allocation unit: one match key in one file. */
function poolKey(file: string, key: string): string {
  return `${file}\u0000${key}`;
}

/**
 * The reported unit's identity: one rule at one file, aggregating the match keys
 * that share both. Exported because a caller deduping a second finding per pool
 * has to name a pool the way the allocator does — one identity, two callers.
 */
export function countKey(rule: string, file: string): string {
  return `${rule}\u0000${file}`;
}

/**
 * The one allocator: within a file and match key, records authorize as a
 * consuming count. Records step in registry order, suppressions are taken in the
 * order supplied, and each record reserves at most one suppression — so N
 * same-file twins need N records, and no record covers every twin.
 *
 * The pairing is recomputed from scratch on every call and never persisted, so
 * nothing about it can go stale. A record's `line` never enters the key: two
 * twin records differing only in their recorded line allocate identically. An
 * expired record reserves nothing, so a valid sibling authorizes past it and
 * document order can never manufacture a shortfall.
 *
 * A pool exists only where there is debt to allocate — one claimable
 * suppression. A record whose suppression aged into pre-existing debt, or whose
 * suppression is gone entirely, is a cleanup story told by its status, and a
 * count line about it would only misdescribe a perfectly fine record. That rule
 * is also why a shortfall pool exists at all: zero records, N claimable
 * suppressions, and the arithmetic `0, 0, 0` is exactly what a developer needs
 * when the gate has just failed.
 */
export function allocateExceptions<S extends LogicalSuppression = LogicalSuppression>(
  input: AllocateExceptionsInput<S>,
): ExceptionAllocation {
  const { records, suppressions, now, claimable } = input;

  const pools = new Map<string, Pool>();
  for (const suppression of suppressions) {
    if (!claimable(suppression)) continue;
    const key = poolKey(suppression.file, matchKey(suppression));
    const pool = pools.get(key);
    if (pool) {
      pool.slots.push(suppression);
    } else {
      pools.set(key, {
        file: suppression.file,
        rule: suppression.rule,
        slots: [suppression],
        matched: 0,
        used: 0,
        reserved: null,
      });
    }
  }

  const pairs: ExceptionPair[] = [];
  const pending: Array<{ record: ExceptionRecord; pool: Pool }> = [];
  for (const record of records) {
    // Expiry keeps precedence and consumes nothing: a record past its date is
    // hygiene, never a slot a valid sibling cannot have.
    if (isExpired(record.expires, now)) continue;
    const pool = pools.get(poolKey(record.file, recordMatchKey(record)));
    if (pool === undefined) continue;
    pool.matched += 1;
    const suppression = pool.slots.shift();
    if (suppression === undefined) {
      pending.push({ record, pool });
      continue;
    }
    pool.used += 1;
    pool.reserved ??= record;
    pairs.push({ record, suppression });
  }

  // The reported unit aggregates every match key sharing a rule and a file, and
  // the counts are ordered by rule then file — the order the sentence reads in.
  // The three numbers are an exact partition of the records that could have
  // reserved a slot, so a pool that balances says so and nothing more.
  const totals = new Map<string, PoolCount>();
  for (const pool of pools.values()) {
    const key = countKey(pool.rule, pool.file);
    const before = totals.get(key);
    const matched = (before?.matched ?? 0) + pool.matched;
    const used = (before?.used ?? 0) + pool.used;
    totals.set(key, { rule: pool.rule, file: pool.file, matched, used, leftover: matched - used });
  }
  const ordered = [...totals.values()].sort(
    (a, b) => compare(a.rule, b.rule) || compare(a.file, b.file),
  );

  return {
    pairs,
    pools: ordered,
    unclaimed: pending.map(({ record, pool }) => ({
      record,
      pool: totals.get(countKey(pool.rule, pool.file))!,
      reserved: pool.reserved,
    })),
  };
}

/** Code-unit order, the way every other ordering in the codebase compares. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ExceptionCoverage {
  head: ReconciledSuppression[];
  statuses: Map<ExceptionRecord, ExceptionStatus>;
  counts: { used: number; expired: number; dangling: number; spent: number };
  /** The `(rule, file)` arithmetic, ordered by rule then file. */
  pools: PoolCount[];
}

export interface CoverExceptionsInput {
  head: ReconciledSuppression[];
  records: ExceptionRecord[];
  now: Date;
}

/** Debt a record can authorize: what this change introduced, not what it inherited. */
function isClaimable(h: ReconciledSuppression): boolean {
  return h.disposition === "new" || h.disposition === "materially-changed";
}

/**
 * Authorize new/materially-changed debt against the registry and classify every
 * record's utilization. Authorization is allocation: a record authorizes one
 * logical suppression in its scoped file, from a consuming count, so same-file
 * twins need a record each and a lookalike elsewhere is unauthorized debt that
 * leaves the record unused.
 */
/**
 * How many records fell to each utilization status. One tally, so the counts
 * `check` publishes and the counts `validate` prints cannot be two hand-rolled
 * versions of the same question that drift apart. `used` is carried too — a
 * well-kept registry is a count worth having even where nothing is unused.
 */
export function utilizationCounts(
  statuses: ReadonlyMap<ExceptionRecord, ExceptionStatus>,
): Record<ExceptionStatus, number> {
  const counts: Record<ExceptionStatus, number> = {
    used: 0,
    dangling: 0,
    spent: 0,
    expired: 0,
  };
  for (const status of statuses.values()) counts[status]++;
  return counts;
}

export function coverExceptions(input: CoverExceptionsInput): ExceptionCoverage {
  const { head, records, now } = input;
  const statuses = new Map<ExceptionRecord, ExceptionStatus>();

  const { pairs, pools } = allocateExceptions({
    records,
    suppressions: head,
    now,
    claimable: isClaimable,
  });
  const authorized = new Map<LogicalSuppression, ExceptionRecord>();
  for (const { record, suppression } of pairs) {
    authorized.set(suppression, record);
    statuses.set(record, "used");
  }

  // The reference a twin carries is the match fields and nothing else: no file,
  // no line, no reason. That is what makes the two records interchangeable as
  // match inputs — and, each being its own record, each authorized separately
  // below. Nothing in the count reads the reference.
  const covered = head.map((h) => {
    const record = authorized.get(h);
    if (record === undefined) return h;
    return {
      ...h,
      exception: {
        fingerprint: record.fingerprint,
        suppressionType: record.suppression_type,
        rule: record.rule,
      },
    };
  });

  // Classify the rest: expired is reported distinctly, then spent, then
  // dangling. Utilization is file-scoped: only a suppression in the record's own
  // file can spend it — a lookalike directive elsewhere never consumes the
  // record. Spending is tried before dangling because a pre-existing matching
  // suppression is what a surplus twin pool looks like: the count left a record
  // over, yet the directive it would have covered was already there, so
  // reporting it as dangling would blame it for debt it never caused.
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

  const counts = utilizationCounts(statuses);
  return { head: covered, statuses, counts, pools };
}

export interface ExpiryPolicyInput {
  /** The baseline registry, as committed: what this change inherited. */
  baseline: readonly ExceptionRecord[];
  /** The registry the change proposes, in registry order. */
  head: readonly ExceptionRecord[];
  now: Date;
  /** The **baseline** policy's maximum. A head-side bump never widens it. */
  maxExpiry: DurationLiteral;
}

/**
 * The refusal half of the expiry policy: the head records that newly write a
 * date past the maximum, and so fail the change writing them. Same predicate as
 * the overlong count below, different tree, different consequence — a far-future
 * date in the baseline is hygiene, the same date newly written is a refusal.
 *
 * "Newly written" is a **multiset** question, not a membership one. Each head
 * record past the horizon consumes one baseline record with the same match key
 * and the same `expires`; one that finds none is a refusal. A set test would
 * read the second of two identical records as already-known and admit "add N
 * more far-future records" forever, which is the dodge this rule exists to stop.
 * The `file` scope is deliberately not part of the identity, so a record that
 * moved to follow a renamed file is the same record, date and all.
 *
 * Permanents are orthogonal: they carry no date to judge, so a temporary
 * converted to a permanent in the same change writes no new expiry.
 */
export function expiryPolicyRefusals(input: ExpiryPolicyInput): ExceptionRecord[] {
  const { baseline, head, now, maxExpiry } = input;
  const horizon = expiryHorizon(now, maxExpiry);

  // What the baseline can still absorb, as a count per (identity, date).
  const available = new Map<string, number>();
  for (const record of baseline) {
    if (record.expires === undefined) continue;
    const key = datedKey(record);
    available.set(key, (available.get(key) ?? 0) + 1);
  }

  const refusals: ExceptionRecord[] = [];
  for (const record of head) {
    if (record.type !== "temporary" || !isOverlong(record, horizon)) continue;
    const key = datedKey(record);
    const left = available.get(key) ?? 0;
    if (left > 0) {
      available.set(key, left - 1);
      continue;
    }
    refusals.push(record);
  }
  return refusals;
}

export interface OverlongRecordsInput {
  records: readonly ExceptionRecord[];
  /** The statuses the evaluation derived for those same records, by identity. */
  statuses: ReadonlyMap<ExceptionRecord, ExceptionStatus>;
  now: Date;
  /** The **baseline** policy's maximum. */
  maxExpiry: DurationLiteral;
}

/**
 * The hygiene half: the baseline records running past the maximum, which still
 * authorize and are counted, never refused — a policy tightening never
 * retroactively fails what has already landed.
 *
 * Expiry keeps precedence here, exactly as it does in allocation: a record the
 * status map calls expired is reported as expired, never also as overlong. The
 * two predicates cannot both hold (an expired date is before today, an overlong
 * one after `today + max`), so this says so structurally instead of leaving it
 * to arithmetic.
 */
export function overlongRecords(input: OverlongRecordsInput): ExceptionRecord[] {
  const { records, statuses, now, maxExpiry } = input;
  const horizon = expiryHorizon(now, maxExpiry);
  return records.filter(
    (record) => statuses.get(record) !== "expired" && isOverlong(record, horizon),
  );
}

/**
 * One refusing record's error line, the wording every surface that refuses a
 * newly written over-max date shares: the CI record's `EXPIRY_POLICY` error and
 * the authoring surface's own refusal. The facts are `validate`'s, deliberately:
 * the date that was written, which record wrote it, the maximum it runs past,
 * and the last date that maximum allows. It does not tell the reader to bump
 * `maxExpiry` — the two-step is a workflow the guides own, not a sentence to
 * repeat on every CI line.
 */
export function expiryPolicyMessage(
  record: ExceptionRecord,
  maxExpiry: DurationLiteral,
  now: Date,
): string {
  return `newly written expires ${record.expires} for ${record.rule} in ${record.file} runs past the baseline ${maxExpiry} maximum (on or before ${expiryHorizon(now, maxExpiry)})`;
}

/** A record's identity together with the date it carries, the refusal multiset's unit. */
function datedKey(record: ExceptionRecord): string {
  return `${recordMatchKey(record)}\u0000${record.expires ?? ""}`;
}
