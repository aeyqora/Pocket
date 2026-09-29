import { matchKey } from "./identity.js";
import { isUnpaired } from "./reconcile.js";
import type {
  Disposition,
  EvaluationRecord,
  ExceptionRecord,
  GuardKind,
  InventoryEntry,
  SuppressionType,
} from "./types.js";

/**
 * The exception match judgment, and the two predicates that compose into it.
 *
 * **Exception match** (`CONTEXT.md`) is the judgment that a record covers a
 * logical suppression. **New debt** is the judgment that the gate blocks on. Both
 * live here because they are one question asked in two orders — first *is this
 * new?*, then *could a record ever cover it?* — and the two halves were once
 * spelled inline at four sites with three different answers.
 *
 * Every predicate here is typed on the fields it reads, not on one carrying
 * shape. A suppression reaches this module as a `LogicalSuppression` from the
 * recognizer, a `ReconciledSuppression` from the reconciler, and an
 * `InventoryEntry` from the record, and all three carry the same facts about
 * identity and disposition. Naming the facts is also what documents what each
 * judgment actually requires of its input.
 */

/** The canonical-identity fields a match key is built from, on either side. */
type MatchFields = {
  readonly fingerprint: string;
  readonly suppressionType: SuppressionType;
  readonly rule: string;
};

/** Disposition and form: everything the two new-debt predicates read. */
type DebtFields = {
  readonly disposition: Disposition;
  readonly guardKind: GuardKind;
};

/**
 * The one statement of what a record can be matched against. A record's
 * canonical identity, in the same shape a suppression's is.
 *
 * This states the *record side* of the key; the suppression side is
 * `identity.ts`'s `matchKey`, and `Fingerprint` is a suppression-side concept
 * (`CONTEXT.md`). The two produce the same shape, which is why the registry
 * refuses a `config-off` record (`validate`): a record's `suppression_type`
 * participates in the key, so a `config-off` suppression's key can never equal
 * any record's.
 */
export function recordMatchKey(record: ExceptionRecord): string {
  return matchKey({
    fingerprint: record.fingerprint,
    suppressionType: record.suppression_type,
    rule: record.rule,
  });
}

/**
 * A record covers a head suppression only in its scoped file: canonical identity
 * (fingerprint + suppression type + rule) plus the record's `file` scope. A
 * lookalike suppression in another file finds no record and stays unauthorized
 * debt.
 *
 * The scope rule here is the same one `poolKey` states as an allocation unit, so
 * the two live together and cannot drift.
 */
export function coversInScope(
  record: ExceptionRecord,
  suppression: MatchFields & { readonly file: string },
): boolean {
  return record.file === suppression.file && recordMatchKey(record) === matchKey(suppression);
}

/**
 * Could any record ever cover this suppression?
 *
 * Exceptability is a property of **Suppression type**, not of **Disposition**:
 * the four directive forms are exceptable, `config-off` is not. A `config-off` is
 * a policy change tracked on the policy track (`POLICY_CHANGE`), never debt a
 * record can authorize — which is why no registry record can name one, and why a
 * suppression failing this can never be anything but unauthorized.
 *
 * Stated on its own, and stated as exceptability rather than as a `guardKind`
 * comparison at each call site, because the two questions it gets composed with
 * are different questions.
 */
export function isExceptable(suppression: { readonly guardKind: GuardKind }): boolean {
  return suppression.guardKind === "directive";
}

/**
 * New debt, as `CONTEXT.md` defines it: a logical suppression with no continuous
 * baseline counterpart, or a materially-changed one, *that an exception could
 * authorize*.
 *
 * The disposition half is `isUnpaired`; the exceptability half is why a new
 * `config-off` is not counted here. Callers that want the unexceptable
 * remainder — the report's "New config-level suppressions" block — ask
 * `isUnpaired` and `!isExceptable` instead, and the two answers partition the
 * head exactly.
 */
export function isNewDebt(suppression: DebtFields): boolean {
  return isUnpaired(suppression) && isExceptable(suppression);
}

/**
 * The new debt an evaluation flags: new debt no record covers. One predicate for
 * the two surfaces that ask the same question — the block a FAIL report prints,
 * and the authoring session offered as a ride-along, where a FAIL with nothing
 * here has nothing to author.
 *
 * It answers about the record rather than about a bare suppression list because
 * both callers hold an `EvaluationRecord`; the narrowing is coverage, not a
 * different kind of debt.
 */
export function flaggedDebt(record: EvaluationRecord): InventoryEntry[] {
  return record.inventory.filter((e) => isNewDebt(e) && e.exception === null);
}

/** The separator every composite key here is built on; git paths cannot contain it. */
const SLOT_SEPARATOR = "\u0000";

/**
 * The allocation unit: one match key in one file. Also the reported unit's
 * identity on the policy-change side, which counts records per slot to decide
 * whether a head slot is new — so both sides name a pool the same way.
 */
export function poolKey(file: string, key: string): string {
  return `${file}${SLOT_SEPARATOR}${key}`;
}

/** The file half of a slot key, recovered by the separator it was built on. */
export function slotFileOf(slot: string): string {
  return slot.slice(0, slot.indexOf(SLOT_SEPARATOR));
}

/** The match-key half of a slot key — the identity a re-point across files keeps. */
export function slotMatchKeyOf(slot: string): string {
  return slot.slice(slot.indexOf(SLOT_SEPARATOR) + 1);
}
