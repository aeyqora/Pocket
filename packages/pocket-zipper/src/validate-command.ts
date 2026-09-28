import { readFileSync } from "node:fs";
import { join } from "node:path";
import { combinedLandingFacts } from "./combined-landing.js";
import { EslintSession } from "./eslint.js";
import { DEFAULT_POLICY, parsePolicy } from "./policy.js";
import { configPluginRuleNames, recognizeFile, type RecognizeFileResult } from "./recognize.js";
import { allocateExceptions, isExpired, type UnclaimedRecord } from "./registry.js";
import {
  PROTECTED_CONFIG,
  PROTECTED_REGISTRY,
  combinedLandingHygiene,
  defectsOf,
  documentDefect,
  poolHygiene,
  recordHygiene,
  renderFinding,
  statusHygiene,
  validateRegistry,
  type Finding,
  type HygieneContext,
  type RegistryEntry,
} from "./validate.js";
import type {
  ExceptionRecord,
  ExceptionStatus,
  LogicalSuppression,
  Policy,
} from "./types.js";

export interface ValidateOptions {
  cwd: string;
  now?: Date;
}

export interface ValidateResult {
  findings: Finding[];
  report: string;
  exitCode: number;
}

/**
 * The working-tree lint of both protected files, in one command. A registry
 * author runs it before pushing: every finding is printed, a defect exits 2,
 * hygiene exits 0, and absent protected files are valid — a repository that
 * governs nothing has nothing wrong with it.
 *
 * There is deliberately no `--strict`. Dangling is a legitimate transient by
 * design (the two-step landing writes the record before the suppression lands),
 * so a mode that failed on hygiene would punish the documented workflow.
 */
export async function runValidate(options: ValidateOptions): Promise<ValidateResult> {
  const now = options.now ?? new Date();
  const cwd = options.cwd;
  const findings: Finding[] = [];

  const configRaw = readProtected(cwd, PROTECTED_CONFIG, findings);
  const registryRaw = readProtected(cwd, PROTECTED_REGISTRY, findings);
  if (configRaw === null && registryRaw === null) {
    return { findings, report: renderValidateReport(findings), exitCode: exitCodeOf(findings) };
  }

  // One ESLint session answers both tree-dependent questions: which rule ids
  // exist here, and which suppressions the working tree still carries. A
  // repository with no usable ESLint has neither answer, so both come back
  // empty: the referential check is skipped, and no record is judged against a
  // tree that was never read.
  const session = await openSession(cwd);
  const knownRules = session === null ? new Set<string>() : await knownRuleIds(session, cwd);

  const policy = readPolicy(configRaw, knownRules, findings);
  const { entries, findings: registryFindings } = validateRegistry(registryRaw);
  findings.push(...registryFindings);
  const scanned = await liveSuppressions(entries, cwd, session);
  const { live, statuses, unclaimed } = judge(entries, scanned, now);
  const ctx: HygieneContext = {
    now,
    maxExpiry: policy.exceptions.maxExpiry,
    knownRules,
    liveLines: live,
  };
  findings.push(...recordHygiene(entries, ctx));
  // The pool's arithmetic before the statuses it explains: the count line is the
  // "why", and a per-record status is the detail it accounts for.
  findings.push(...poolHygiene(entries, unclaimed));
  findings.push(...statusHygiene(entries, statuses, ctx));
  // Last, because these two are not about a record at all: they corroborate what
  // the checkout says about itself, which no registry reading can speak to.
  findings.push(...combinedLandingHygiene(await combinedLandingFacts(cwd, policy)));

  return { findings, report: renderValidateReport(findings), exitCode: exitCodeOf(findings) };
}

/** A defect fails closed; hygiene never fails on its own. */
export function exitCodeOf(findings: readonly Finding[]): number {
  return defectsOf(findings).length > 0 ? 2 : 0;
}

/**
 * Every finding, one diagnostic line each. Order is by pass, not by position:
 * the config's defect first, then the registry's defects in document order,
 * then what each record's own text says, then what its pool's arithmetic says,
 * then what each record's relationship to the tree says. The verdict line
 * carries both counts so CI can branch on the two tiers without parsing them.
 */
export function renderValidateReport(findings: readonly Finding[]): string {
  const defects = defectsOf(findings).length;
  const hygiene = findings.length - defects;
  const lines = [
    `pocket-zipper: ${defects === 0 ? "OK" : "INVALID"} (${plural(defects, "defect")}, ${plural(hygiene, "hygiene finding")})`,
  ];
  if (findings.length > 0) {
    lines.push("");
    for (const finding of findings) lines.push(renderFinding(finding));
  }
  return lines.join("\n") + "\n";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A protected file's text, or the reason it cannot be read. Only a file that is
 * genuinely not there is "absent" — a registry this command cannot read (a
 * permissions error, a directory where a file should be) is a defect, not a
 * clean repository, and is reported as one.
 */
function readProtected(root: string, path: string, findings: Finding[]): string | null {
  try {
    return readIfPresent(root, path);
  } catch (err) {
    findings.push(documentDefect(path, readErrorMessage(err)));
    return null;
  }
}

/** A file's text, or null when it is not there at all. Throws on any other failure. */
function readIfPresent(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

function readErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code ?? "unknown error";
  return `the document could not be read (${code})`;
}

async function openSession(cwd: string): Promise<EslintSession | null> {
  try {
    return await EslintSession.create(cwd);
  } catch {
    return null;
  }
}

/**
 * Every rule id ESLint knows in this tree: the core rules plus whatever the
 * plugins declared in the flat config contribute. The same set
 * `parsePolicy` validates a `governedRules` allowlist against, so a rule id
 * accepted by the policy is accepted by a record naming it.
 */
async function knownRuleIds(session: EslintSession, cwd: string): Promise<Set<string>> {
  const known = session.coreRuleNames();
  for (const name of await configPluginRuleNames(cwd)) known.add(name);
  return known;
}

/**
 * The strict config parse (ticket 01), with its diagnostic promoted to a defect
 * so it lands in the same two-tier report as the registry's: a policy document
 * that cannot be read is not a valid instance of the policy, whatever it says.
 * The canonical defaults carry the registry checks on, so one broken config key
 * does not hide the rest of the file's findings.
 */
function readPolicy(raw: string | null, knownRules: Set<string>, findings: Finding[]): Policy {
  try {
    return parsePolicy(raw, knownRules);
  } catch (err) {
    findings.push(
      documentDefect(
        PROTECTED_CONFIG,
        configMessage(err instanceof Error ? err.message : String(err)),
      ),
    );
    return DEFAULT_POLICY;
  }
}

/**
 * `parsePolicy` names the file in its own messages, because those messages also
 * travel as standalone errors. A diagnostic line already carries the path, so
 * the name is dropped here rather than printed twice on one line. The one
 * message with no separator is the parse failure, and it gets the wording
 * `parsePolicy` leaves implicit.
 */
function configMessage(message: string): string {
  const named = message.startsWith(`${PROTECTED_CONFIG}: `)
    ? message.slice(PROTECTED_CONFIG.length + 2)
    : message;
  return named === `malformed ${PROTECTED_CONFIG}`
    ? "the policy document is not a well-formed YAML mapping"
    : named;
}

/**
 * The working tree's live suppressions, in the order the files a registry names
 * yield them: by file, then by the tree's own document order within the file.
 * That order is the allocator's, not a special case of it — allocation is a
 * consuming count, and both callers hand their suppressions over in document
 * order for it to consume.
 */
interface LiveSuppressions {
  readonly live: LogicalSuppression[];
  /**
   * Records whose file could not be read, so the tree gave them no verdict. An
   * unreadable file is no evidence about its records: they are unjudged, never
   * dangling, and take no part in allocation.
   */
  readonly unjudged: ReadonlySet<ExceptionRecord>;
}

interface Judgement {
  /** The live line each `used` record's suppression sits on, for the stale note. */
  readonly live: Map<ExceptionRecord, number>;
  readonly statuses: Map<ExceptionRecord, ExceptionStatus>;
  /** The records allocation left over, with each pool's arithmetic. */
  readonly unclaimed: UnclaimedRecord[];
}

/**
 * Classify every record against the working tree's own suppressions, through the
 * one allocator the evaluation uses. A record matching a live suppression in its
 * scoped file is in use; one past its expiry is expired; the rest match nothing
 * and are dangling. Expiry keeps precedence and consumes nothing, so an expired
 * record never takes a live suppression away from a record that could still use
 * it. A record the tree could not judge is left out of allocation entirely — an
 * unreadable file is no evidence either way — but its date is still read, so
 * expiry is reported even for a record nothing else could judge.
 *
 * `spent` is not derivable here — it is a change-relative judgment (the
 * suppression became pre-existing debt) that belongs to an evaluation, not to a
 * working-tree lint, and needs a baseline this command does not have.
 */
function judge(
  entries: readonly RegistryEntry[],
  scanned: LiveSuppressions,
  now: Date,
): Judgement {
  const judged = entries.filter(({ record }) => !scanned.unjudged.has(record));
  const { pairs, unclaimed } = allocateExceptions({
    records: judged.map((entry) => entry.record),
    suppressions: scanned.live,
    now,
    claimable: () => true,
  });
  const live = new Map<ExceptionRecord, number>();
  const statuses = new Map<ExceptionRecord, ExceptionStatus>();
  for (const { record, suppression } of pairs) {
    live.set(record, suppression.line);
    statuses.set(record, "used");
  }
  for (const { record } of entries) {
    if (statuses.has(record)) continue;
    // Expiry is judged for every record, including one the tree could not read:
    // a date is knowable without a tree, and an unreadable file is no reason to
    // stop saying a record is out of date. Expiry also outranks allocation, so a
    // record that expired and would have matched spends nothing on the question.
    if (isExpired(record.expires, now)) statuses.set(record, "expired");
    // Everything else the tree could not judge stays unjudged rather than
    // dangling: an unreadable file is not evidence that its exception went unused.
    else if (!scanned.unjudged.has(record)) statuses.set(record, "dangling");
  }
  return { live, statuses, unclaimed };
}

/**
 * The working tree's live suppressions, for the allocator to consume. Only the
 * files a record names are linted: a registry that excepts nothing in a file has
 * no claim on that file, and inventorying a whole repository to answer "does
 * this record still match?" would cost a repository-wide pass for every
 * question the registry asks.
 */
async function liveSuppressions(
  entries: readonly RegistryEntry[],
  cwd: string,
  session: EslintSession | null,
): Promise<LiveSuppressions> {
  const entriesByFile = new Map<string, RegistryEntry[]>();
  for (const entry of entries) {
    const bucket = entriesByFile.get(entry.record.file);
    if (bucket) bucket.push(entry);
    else entriesByFile.set(entry.record.file, [entry]);
  }
  // No usable ESLint: no file is readable, so no record is judged.
  if (session === null) {
    return { live: [], unjudged: new Set(entries.map((e) => e.record)) };
  }

  const live: LogicalSuppression[] = [];
  const unjudged = new Set<ExceptionRecord>();
  for (const [file, fileEntries] of entriesByFile) {
    // An unreadable scoped file is not a finding here — the two protected files
    // are — it just leaves its records with nothing to be judged against.
    const recognized = await recognizeQuietly(session, cwd, file, readQuietly(cwd, file));
    if (recognized === null) {
      for (const { record } of fileEntries) unjudged.add(record);
      continue;
    }
    live.push(...recognized.suppressions);
  }
  return { live, unjudged };
}

/** A file's text, or null when it is missing or unreadable. */
function readQuietly(root: string, path: string): string | null {
  try {
    return readIfPresent(root, path);
  } catch {
    return null;
  }
}

/**
 * Recognition, or null when the tree cannot be read. ESLint is what reads a
 * file's suppressions, so a tree it cannot run over is a tree this command
 * cannot judge records against: the records naming it get no verdict rather
 * than a `dangling` the tree never earned.
 */
async function recognizeQuietly(
  session: EslintSession,
  cwd: string,
  file: string,
  content: string | null,
): Promise<RecognizeFileResult | null> {
  if (content === null) return null;
  try {
    return await recognizeFile({ session, treeDir: cwd, relFile: file, content });
  } catch {
    return null;
  }
}
