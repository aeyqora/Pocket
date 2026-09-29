import { coversInScope } from "./exception-match.js";
import { PROTECTED_REGISTRY, type RegistryEntry } from "./validate.js";

import type {
  DurationLiteral,
  ExceptionRecord,
  ExceptionStatus,
  LogicalSuppression,
  UnusedException,
} from "./types.js";

/**
 * The cleanup surfaces: everything the tool says about records that authorize
 * nothing, in one module so `check` and `validate` cannot drift apart.
 *
 * The posture is fixed by the registry's own rules and never by this module:
 * **the core never deletes a record and never posts about one.** Every surface
 * here is a pointer — where the record is, what it says, what made it unused —
 * for a human to action through an ordinary protected-PR edit. A registry
 * removal is a narrowing, so it is never a `POLICY_CHANGE` and never needs a
 * second approval; git history is the audit trail, and `git blame` on the
 * record's lines is how a maintainer finds the human to ask.
 */

/**
 * The notice every surface that lists unused records carries in its header, so
 * the remedy is visible where the records are rather than only in a guide
 * nobody opened. The guide is where the maintainer's `git blame` technique and
 * the full two-part rhythm live.
 */
export const CLEANING_GUIDE =
  "remove each in a protected PR; see docs/guides/cleaning-up-unused-exceptions.md";

/**
 * The annotation a change earns by clearing a suppression: the one message that
 * reaches the author of the change rather than a maintainer sweeping later.
 * Derived suppression-side (removed suppressions × baseline records), so it is
 * correct whatever allocation says about which of a twin pool dangles.
 */
export const CLEARED_BY_THIS_CHANGE =
  "cleared by this change — record now unused; remove it in a protected PR";

export interface UnusedExceptionsInput {
  /** The registry as read, carrying each record's position and text. */
  readonly entries: readonly RegistryEntry[];
  /** The utilization status each of those records was given. */
  readonly statuses: ReadonlyMap<ExceptionRecord, ExceptionStatus>;
  /**
   * The suppressions still in the tree, in document order — where a record
   * that still has its suppression is now. `check` passes its reconciled head;
   * `validate` passes the working tree's live suppressions.
   */
  readonly live: readonly LogicalSuppression[];
  /**
   * The suppressions this change removed, for the `cleared by this change`
   * annotation. Empty where there is no change to speak of (`validate`), which
   * is why the annotation is suppression-side: it needs a diff, not a guess.
   */
  readonly removed?: readonly LogicalSuppression[];
}

/**
 * Every unused record, with the pointer that finds it — the addresses behind
 * the counts. Registry order, so a reader scans the file the way it is written.
 *
 * The records are the **baseline** registry's: the file as the evaluation
 * judged coverage against, and the file whose entry numbers a maintainer counts
 * to. A record the change itself removes is still reported — it was unused for
 * a moment, and a maintainer reading the report of that change is exactly who
 * needs to be told the deletion already happened rather than still owed.
 */
export function unusedExceptions(input: UnusedExceptionsInput): UnusedException[] {
  const { entries, statuses, live, removed = [] } = input;
  const total = entries.length;

  const unused: UnusedException[] = [];
  for (const { index, record, registryLines, text } of entries) {
    const status = statuses.get(record);
    if (status === undefined || status === "used") continue;
    unused.push({
      status,
      entry: index,
      entries: total,
      registryLines,
      text,
      live: liveLocation(record, live),
      recorded: record.line ?? null,
      clearedByThisChange: clearedBy(record, removed),
    });
  }
  return unused;
}

/**
 * Where a record's suppression is *now*, which is the only location a reader
 * can act on. A dangling record has none — nothing matches it — which is what
 * makes its stored `line` a last-known location rather than a stale one. The
 * first matching suppression in document order stands for the pool, so a twin
 * pool points at the first twin that is still there.
 *
 * The match is the allocator's own, so this surface and the allocator cannot
 * spell scope and identity differently. It needs no exceptability clause: a
 * record's `suppression_type` participates in the match key and no record may
 * name a `config-off`, so an unexceptable suppression can never match one.
 */
function liveLocation(
  record: ExceptionRecord,
  live: readonly LogicalSuppression[],
): { file: string; line: number } | null {
  const found = live.find((s) => coversInScope(record, s));
  return found === undefined ? null : { file: found.file, line: found.line };
}

/**
 * Whether this change is what orphaned the record: one of the suppressions it
 * removed was the one this record excepts. Asked suppression-side, so the
 * answer does not depend on which twin record allocation happened to leave
 * over.
 */
function clearedBy(
  record: ExceptionRecord,
  removed: readonly LogicalSuppression[],
): boolean {
  return removed.some((s) => coversInScope(record, s));
}

/**
 * The locate-and-delete pointer, in the exact form the spec fixes:
 * `entry N of M · .pocket-zipper/exceptions.yml:lines`. Nothing else rides on
 * this line — a CI step and a maintainer's muscle memory both key on it, and a
 * status spliced in after the range would break the first for no gain.
 *
 * Every number on it indexes the *registry* file. The record's own `line` field
 * indexes the source file and means something else entirely; see
 * `UnusedException.registryLines`.
 */
export function cleanupPointer(unused: UnusedException): string {
  const lines = unused.registryLines;
  const where =
    lines === null
      ? ""
      : `:${lines.start === lines.end ? lines.start : `${lines.start}-${lines.end}`}`;
  return `  entry ${unused.entry} of ${unused.entries} · ${PROTECTED_REGISTRY}${where}`;
}

/**
 * The record's status and where its suppression is, on its own line under the
 * pointer. A record whose suppression is gone has no current location, and its
 * stored line is honestly the last one it knew; a record whose suppression is
 * still there is named at where it is, with the record's own number beside it
 * only as the drift it is.
 *
 * The drift clause is informational and always was: a reader comparing `record
 * says 12, currently at 141` learns the record moved and gets nothing to act
 * on beyond deleting the record, which is the whole remedy either way.
 */
function cleanupLocation(unused: UnusedException): string {
  const live = unused.live;
  const where =
    live === null
      ? unused.recorded === null
        ? "no line recorded"
        : `last known: ${unused.recorded}`
      : unused.recorded === null || unused.recorded === live.line
        ? `at ${live.file}:${live.line}`
        : `at ${live.file}:${live.line} (record says ${unused.recorded}, currently at ${live.line})`;
  return `    ${unused.status}; ${where}`;
}

/**
 * Where the record's suppression is, in the words that fit what is knowable.
 * A record whose suppression is gone has no current location, and its stored
 * line is honestly the last one it knew; a record whose suppression is still
 * there is named at where it is, with the record's own number beside it only as
 * the drift it is.
 */
function locationOf(unused: UnusedException): string {
  const live = unused.live;
  if (live === null) {
    return unused.recorded === null
      ? "no line recorded"
      : `last known: line ${unused.recorded}`;
  }
  if (unused.recorded === null || unused.recorded === live.line) {
    return `at ${live.file}:${live.line}`;
  }
  return `at ${live.file}:${live.line} (record says ${unused.recorded}, currently at ${live.line})`;
}

/**
 * The whole delete-ready block for one unused record: the pointer, the record's
 * status and location, the `cleared by this change` annotation where this
 * change earned it, and the record's own text so the maintainer can confirm at
 * a glance that the pointer lands on the record they think it does.
 */
export function cleanupBlock(unused: UnusedException): string[] {
  const lines = [cleanupPointer(unused), cleanupLocation(unused)];
  if (unused.clearedByThisChange) lines.push(`    ${CLEARED_BY_THIS_CHANGE}`);
  for (const line of unused.text.split("\n")) lines.push(line.length === 0 ? "" : `    ${line}`);
  return lines;
}

/**
 * The greppable, pipeable rollup: bare counts, no names, one line. A repo's own
 * CI greps for it and turns it into whatever notification shape that host
 * supports — the core posts nothing, and addresses no one, because deletion
 * follows git history rather than an inbox.
 *
 * Spelled with the two counts the contract fixes, so a CI step can parse it
 * without knowing this version's report. Expired records are not in the
 * contract's arithmetic; the human surfaces above carry them.
 */
export function cleanupRollup(
  counts: Pick<CleanupCounts, "danglingExceptions" | "spentExceptions">,
): string {
  return `pocket-zipper-cleanup: ${counts.danglingExceptions} dangling, ${counts.spentExceptions} spent`;
}

export interface CleanupCounts {
  danglingExceptions: number;
  spentExceptions: number;
  expiredExceptions: number;
  overlongExceptions: number;
  unused: readonly UnusedException[];
}

export interface CleanupSectionOptions {
  /**
   * The policy maximum, named by the overlong line — the one field here a
   * reader might not expect, because it names the ceiling rather than a
   * finding. The count and the maximum come from one evaluation, so a nonzero
   * overlong count without one was produced against the default policy.
   */
  maxExpiry: DurationLiteral;
  /**
   * Who is reading. The section carries both a tally and a set of addresses,
   * and which of them a reader gets is a question about the reader — never
   * about what is true. An enumeration rather than two booleans, because the
   * two are not independent choices: they are three stances.
   */
  audience: CleanupAudience;
}

/**
 * The three stances the section has to answer to, as one enumeration.
 * `change-author` and `ci-log` are opposites — addresses or tally — and
 * `maintainer-sweep` is the one surface that wants both, because it is a person
 * finding records *and* the line a repo's CI step greps for.
 */
export type CleanupAudience = "change-author" | "ci-log" | "maintainer-sweep";

/** Does this reader get the addresses, the rollup, or both? */
const READS: Record<CleanupAudience, { perRecord: boolean; rollup: boolean }> = {
  "change-author": { perRecord: true, rollup: false },
  "ci-log": { perRecord: false, rollup: true },
  "maintainer-sweep": { perRecord: true, rollup: true },
};

/**
 * The whole cleanup section, in one wording, for every surface that prints one.
 *
 * The counts are the tally and the records are the addresses. An overlong
 * record is not an *unused* one — it authorizes right up to its date — so it
 * gets its own line beside the tally rather than a place inside it, and it
 * prints only when the count is nonzero: a well-kept registry with one
 * far-future record is hygiene to report, not a standing comment on every run.
 *
 * The overlong line belongs to the *evaluation* surfaces only. `validate` says
 * the same thing per record, with more to say (which record, which date, what
 * the maximum allows), and a third statement of one fact on the surface that
 * already states it best is noise, not information.
 *
 * Returns a leading blank line when there is anything to say, so both callers
 * can append the result unconditionally.
 */
export function renderCleanupSection(
  counts: CleanupCounts,
  options: CleanupSectionOptions,
): string[] {
  const reads = READS[options.audience];
  const lines: string[] = [];
  if (counts.danglingExceptions + counts.spentExceptions + counts.expiredExceptions > 0) {
    // The guide rides in the header, not in a child line beneath it: a reader
    // who scans only the header of a section listing records to delete is
    // exactly the reader the pointer is for.
    lines.push(
      `Unused exceptions: dangling ${counts.danglingExceptions}, spent ${counts.spentExceptions}, expired ${counts.expiredExceptions}` +
        (reads.perRecord ? ` — ${CLEANING_GUIDE}` : ""),
    );
    if (reads.perRecord) {
      for (const unused of counts.unused) lines.push(...cleanupBlock(unused));
    }
    if (reads.rollup) lines.push(cleanupRollup(counts));
  }
  return lines.length === 0 ? [] : ["", ...lines];
}

/**
 * The overlong line, for the evaluation surfaces. An overlong record is not an
 * *unused* one — it authorizes right up to its date — so it gets its own line
 * beside the tally rather than a place inside it, and it prints only when the
 * count is nonzero: a well-kept registry with one far-future record is hygiene
 * to report, not a standing comment on every run.
 */
export function renderOverlongLine(
  overlongExceptions: number,
  maxExpiry: DurationLiteral,
): string[] {
  if (overlongExceptions === 0) return [];
  return [
    `  Overlong exceptions: ${overlongExceptions} (expires past the ${maxExpiry} maximum)`,
  ];
}
