import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { EMPTY_TREE, Git } from "./git.js";
import { EslintSession } from "./eslint.js";
import { configPluginRuleNames } from "./recognize.js";
import { analyzeTrees, reconcileGoverned } from "./pipeline.js";
import { flaggedDebt, isNewDebt } from "./exception-match.js";
import { governedPathSet, isGovernedPath } from "./governed-path.js";
import {
  daysBetween,
  describeDuration,
  expiryHorizon,
  isoDay,
  parsePolicy,
  suggestedExpiry,
} from "./policy.js";
import {
  coverExceptions,
  expiryPolicyMessage,
  expiryPolicyRefusals,
} from "./registry.js";
import { editFields, type FieldEdit } from "./registry-edit.js";
import { readProtectedDocument } from "./protected-document.js";
import { defectsOf, renderFinding, type Finding } from "./finding.js";
import { isCalendarDate, isIsoDateForm, validateRegistry } from "./validate.js";
import type { RegistryEntry } from "./validate.js";
import { PROTECTED_CONFIG, PROTECTED_REGISTRY } from "./protected-paths.js";

import { PocketZipperError } from "./errors.js";
import type {
  EvaluationRecord,
  ExceptionRecord,
  InventoryEntry,
  Policy,
  ReconciledSuppression,
  SuppressionType,
} from "./types.js";

export interface ExceptionAddOptions {
  cwd: string;
  now?: Date;
  /**
   * `--from <file>:<line>` — the suppression to record, selected instead of
   * picked: present, the session is non-interactive (a script or an agent
   * supplies the interview through flags, and the expiry prefills from the
   * policy default).
   */
  from?: string;
  /** `--reason <text>` — the interview's required answer. */
  reason?: string;
  /** `--reference <link>` — the interview's optional answer. */
  reference?: string;
  /**
   * The ride-along's selection: the suppressions a FAIL report flagged, already
   * chosen. Present, the session is the post-failure one — no session-choice
   * step, no pick step, and the prefill comes from the failed report's own
   * copy-paste-ready record rather than from a fresh inventory.
   */
  preselect?: readonly MatchFields[];
  /** The stream prompts are read from; defaults to the process's stdin. */
  input?: NodeJS.ReadableStream;
  /** The stream the transcript is written to; defaults to the process's stdout. */
  output?: NodeJS.WritableStream;
  /** The stream operational errors are written to; defaults to stderr. */
  stderr?: NodeJS.WritableStream;
}

export interface ExceptionAddResult {
  exitCode: number;
}

export interface RideAlongOptions {
  /** The evaluation that failed — the report the author is reading. */
  record: EvaluationRecord;
  cwd: string;
  now: Date;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * The machine-authored half of one record: the match fields an inventory knows
 * and an author never types. Both front doors supply the same shape — the
 * dedicated command from the working tree's inventory, the ride-along from the
 * FAIL report's flagged entries — so the write itself cannot tell which door it
 * came through, and neither can the transcript below it.
 */
export interface MatchFields {
  rule: string;
  suppressionType: SuppressionType;
  fingerprint: string;
  file: string;
  /** Absent only when the inventory could not place the directive. */
  line?: number;
}

/** The answer set the interview collects: a reason, and a reference or none. */
interface Detail {
  reason: string;
  /** Empty when the reference prompt was skipped — the record omits the field. */
  reference: string;
}

/** The one expiry decision the whole write carries. */
type ExpiryDecision = { kind: "temporary"; date: string } | { kind: "permanent" };

/**
 * The wizard: the machine-authored authoring surface behind
 * `pocket-zipper exception add`. Fingerprint, rule, suppression type, file,
 * and line are prefilled from a working-tree inventory recomputed with the same
 * engine `check` reads with; the author answers only reason (required),
 * reference (optional), and one expiry decision for the whole write. The write
 * is a proposal — validated through the shared registry validator, appended to
 * the working-tree registry, and stated as taking effect only once approved and
 * merged. Never the authorizing step, and never the owner of a config it will
 * not scaffold: a repo with no `config.yml` is handed back to the authorizers.
 */
export async function runExceptionAdd(
  options: ExceptionAddOptions,
): Promise<ExceptionAddResult> {
  const runtime = runtimeOf(options);
  try {
    if (options.from !== undefined) {
      return await withSession(runtime, (session) => scriptedSession(session, options));
    }
    return await interactiveSession(runtime, options.preselect);
  } catch (err) {
    return { exitCode: operationalFailure(runtime.error, err) };
  }
}

/**
 * The post-failure ride-along: the second front door, offered at the end of a
 * local `check` FAIL. A FAIL with no flagged debt has nothing to author, so the
 * offer is never made; a declined one costs the author nothing but a keystroke.
 * Accepted, the session runs the interview against the report's own flagged
 * entries — the failing suppressions are pre-selected, so nothing is
 * re-identified — and the gate's verdict stands whatever the write did: the
 * check already failed, and authoring a record does not un-fail it.
 */
export async function offerExceptionAdd(options: RideAlongOptions): Promise<ExceptionAddResult> {
  const runtime = runtimeOf(options);
  const targets = flaggedDebt(options.record).map(matchFieldsOf);
  if (targets.length === 0) return { exitCode: 0 };
  const prompts = new Prompter(runtime.input, runtime.out);
  try {
    // The selection is stated before the question, not after the answer: a FAIL
    // can flag several suppressions, and one `y` authorizes records for all of
    // them, so the author must see the list they are saying yes to.
    announce(prompts, targets);
    const offered = await askYesNo(
      prompts,
      "create an exception for this debt? [y/N]",
      "type y to author an exception for this debt, or press Enter to leave it",
    );
    if (!offered) return { exitCode: 0 };
    return await sessionWithPrompter(runtime, prompts, targets);
  } catch (err) {
    return { exitCode: operationalFailure(runtime.error, err) };
  } finally {
    prompts.close();
  }
}

/**
 * One flagged inventory entry as the prefill the ride-along authors from: the
 * match fields the FAIL report already printed, machine-authored either way.
 * An entry whose head line the report could not place carries no line, and the
 * record is written without one — the format's `line` is optional reference
 * data, and a guessed line is worse than none.
 */
function matchFieldsOf(entry: InventoryEntry): MatchFields {
  return {
    rule: entry.rule,
    suppressionType: entry.suppressionType,
    fingerprint: entry.fingerprint,
    file: entry.file,
    ...(entry.lines.head === null ? {} : { line: entry.lines.head }),
  };
}

// --- the run's streams and clock ---------------------------------------------

/** What a run reads and writes before the repository is opened. */
interface Runtime {
  cwd: string;
  now: Date;
  input: NodeJS.ReadableStream;
  out: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
}

/** The streams and the clock a run needs, however it was asked for. */
function runtimeOf(options: {
  cwd: string;
  now?: Date;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}): Runtime {
  return {
    cwd: options.cwd,
    now: options.now ?? new Date(),
    input: options.input ?? process.stdin,
    out: options.output ?? process.stdout,
    error: options.stderr ?? process.stderr,
  };
}

/** The exit code every operational failure carries, and the line it writes. */
function operationalFailure(error: NodeJS.WritableStream, err: unknown): number {
  if (err instanceof PocketZipperError) {
    error.write(`${err.message}\n`);
    return 2;
  }
  error.write(
    `pocket-zipper: internal error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  return 2;
}

// --- the boot ----------------------------------------------------------------

/** What one session iteration reads: both halves of its inventory input. */
interface SessionInput {
  git: Git;
  policy: Policy;
  /** The baseline commit the working tree is read against: HEAD, or the empty tree. */
  baselineCommit: string;
  baselineDir: string;
  baselineSession: EslintSession;
  headSession: EslintSession;
  now: Date;
  out: NodeJS.WritableStream;
  /** Where a refusal this session cannot ask about is written. */
  error: NodeJS.WritableStream;
}

/** A booted session and the temporary tree it must hand back when it is done. */
interface Booted {
  session: SessionInput;
  done: () => void;
}

/**
 * Everything both front doors need before a single question is asked: the repo,
 * the baseline-authoritative policy, and the two ESLint sessions the inventory
 * is read through. Each refusal path here is a line the author reads, not an
 * error, because every one of them is a state this repo is honestly in.
 */
async function bootSession(runtime: Runtime): Promise<Booted | { exitCode: number }> {
  const { out, error } = runtime;
  const git = await Git.discover(runtime.cwd);
  // The wizard writes the working tree's registry; a bare checkout has none.
  if (git.isBare()) {
    error.write("exception add requires a work tree\n");
    return { exitCode: 2 };
  }

  // Baseline-authoritative, like every evaluation: the policy is HEAD's
  // (the empty tree for an unborn repo), never the working tree's, so an
  // uncommitted `maxExpiry` bump cannot hand back a record the gate would
  // refuse. No config at the baseline is the blocked posture — governance is
  // an authorizer's decision, and this flow never makes it for them.
  const baselineCommit = git.hasCommit("HEAD") ? git.revParse("HEAD") : EMPTY_TREE;
  const configRaw = git.fileAt(baselineCommit, PROTECTED_CONFIG);
  if (configRaw === null) {
    out.write("Pocket Zipper isn't configured in this repo (no .pocket-zipper/config.yml)\n");
    out.write(
      "nothing can be written here — config is set up by the repo's authorizers at install time, not by this flow\n",
    );
    return { exitCode: 1 };
  }
  const initialPolicy = parsePolicy(configRaw, new Set<string>());
  if (!initialPolicy.enabled) {
    out.write("the gate is disabled in this repo's policy — no debt requires an exception.\n");
    return { exitCode: 0 };
  }

  const baselineDir = git.materialize(baselineCommit);
  try {
    const baselineSession = await EslintSession.create(baselineDir);
    const headSession = await EslintSession.create(git.root);
    const knownRules = headSession.coreRuleNames();
    for (const name of await configPluginRuleNames(baselineDir)) knownRules.add(name);
    for (const name of await configPluginRuleNames(git.root)) knownRules.add(name);
    const policy = parsePolicy(configRaw, knownRules);
    return {
      session: {
        git,
        policy,
        baselineCommit,
        baselineDir,
        baselineSession,
        headSession,
        now: runtime.now,
        out,
        error,
      },
      done: () => git.cleanup(baselineDir),
    };
  } catch (err) {
    git.cleanup(baselineDir);
    throw err;
  }
}

/**
 * One run of a session, however it was reached: boot the repository, hand the
 * booted session to `body`, and hand the temporary tree back whatever `body`
 * does. The only place that pairing is written down, so no caller can boot
 * without cleaning up and no boot's refusal can be answered twice.
 */
async function withSession(
  runtime: Runtime,
  body: (session: SessionInput) => Promise<ExceptionAddResult>,
): Promise<ExceptionAddResult> {
  const booted = await bootSession(runtime);
  if ("exitCode" in booted) return { exitCode: booted.exitCode };
  try {
    return await body(booted.session);
  } finally {
    booted.done();
  }
}

/** The interactive run: its own prompter, then as many sessions as the author asks for. */
async function interactiveSession(
  runtime: Runtime,
  preselect?: readonly MatchFields[],
): Promise<ExceptionAddResult> {
  const prompts = new Prompter(runtime.input, runtime.out);
  try {
    return await sessionWithPrompter(runtime, prompts, preselect);
  } finally {
    prompts.close();
  }
}

/** A session loop over a prompter the caller already owns — the ride-along's, which asked its question first. */
async function sessionWithPrompter(
  runtime: Runtime,
  prompts: Prompter,
  preselect?: readonly MatchFields[],
): Promise<ExceptionAddResult> {
  return withSession(runtime, (session) => sessionLoop(session, prompts, preselect));
}

// --- the session's shared reads ---------------------------------------------

/** The working-tree registry, as the write needs it: its bytes, its entries. */
interface WorkingRegistry {
  raw: string | null;
  entries: RegistryEntry[];
  records: ExceptionRecord[];
}

/**
 * The working-tree registry, fail-closed like every registry read: a defect
 * prints its diagnostics and refuses the session (exit 2); a file that is
 * genuinely not there is an empty registry the write will create.
 */
function readRegistry(
  root: string,
  out: NodeJS.WritableStream,
): WorkingRegistry | { exitCode: number } {
  const { raw, defect } = readProtectedDocument(root, PROTECTED_REGISTRY);
  if (defect !== null) {
    out.write(`${renderFinding(defect)}\n`);
    return { exitCode: 2 };
  }
  const validation = validateRegistry(raw);
  const defects = defectsOf(validation.findings);
  if (defects.length > 0) {
    for (const finding of defects) out.write(`${renderFinding(finding)}\n`);
    return { exitCode: 2 };
  }
  return {
    raw,
    entries: validation.entries,
    records: validation.entries.map((entry) => entry.record),
  };
}

/**
 * The working tree's new debt — the FAIL report's flagged list, recomputed for
 * the tree instead of a merge: governed directive-form suppressions the change
 * introduces, that no record in the working-tree registry covers. The
 * working-tree registry is the honest coverage for a working-tree surface, so
 * a record a previous wizard session wrote takes its suppression off this list
 * on the next pass. The ride-along skips this read entirely: its selection came
 * with the report, and the tree it would be recomputed against is not the tree
 * that failed.
 */
async function readDebt(
  input: SessionInput & { records: ExceptionRecord[] },
): Promise<ReconciledSuppression[]> {
  const { git, policy, baselineCommit, baselineDir, baselineSession, headSession, now, records } =
    input;
  const analysis = await analyzeTrees({
    baselineDir,
    headDir: git.root,
    baselineSession,
    headSession,
    changeMap: git.worktreeChangeMap(),
    baselineContent: (path) => git.fileAt(baselineCommit, path),
    headContent: (path) => readWorktreeFile(git.root, path),
    isGovernedPath: (path) => isGovernedPath(policy, path),
  });
  const { head } = reconcileGoverned({
    policy,
    analysis,
    governedPaths: governedPathSet(policy, git.trackedPaths(baselineCommit)),
  });
  const coverage = coverExceptions({ head, records, now });
  return coverage.head.filter((h) => isNewDebt(h) && h.exception === null);
}

/** A working-tree file's text, or null when it is absent or not text at all. */
function readWorktreeFile(root: string, path: string): string | null {
  try {
    const text = readFileSync(join(root, path), "utf8");
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

// --- the interactive session loop -------------------------------------------

/**
 * How one session ended: `end` for the invocation itself (the author abandoned
 * it, or there was nothing to do), `done` for a session that reached its write
 * prompt and was written or declined.
 */
type SessionStep = { kind: "end"; exitCode?: number } | { kind: "done"; wrote: boolean };

/**
 * One command invocation, zero or more sessions: `run another session?` loops
 * back to the top, recomputing the registry and the debt list against the
 * tree as the previous session left it. A ride-along is the first session and
 * only the first: a second session is the dedicated command in its own right,
 * so it gets the session choice like any other.
 */
async function sessionLoop(
  input: SessionInput,
  prompts: Prompter,
  preselect?: readonly MatchFields[],
): Promise<ExceptionAddResult> {
  let wrote = false;
  let completed = false;
  let ride = preselect;
  for (;;) {
    const { out } = input;
    const registry = readRegistry(input.git.root, out);
    if ("exitCode" in registry) return { exitCode: registry.exitCode };

    let step: SessionStep;
    if (ride !== undefined) {
      // The ride-along's inventory is the report it arrived with, so there is no
      // debt list here to read and none to pick from: the selection is the one
      // the failure already made.
      const targets = ride;
      ride = undefined;
      step = await newDebtSession(prompts, input, registry, [], targets);
    } else {
      out.write("reading the working tree's new debt…\n");
      const debt = await readDebt({ ...input, records: registry.records });
      out.write("this session is for:\n");
      out.write("  1) new debt from this change\n");
      out.write("  2) renew an expiring record\n");
      const choice = await chooseSession(prompts);
      if (choice === null) return exitOf(wrote, completed);
      if (choice === "new") out.write("→ new debt\n");
      step =
        choice === "renew"
          ? await renewSession(prompts, input, registry)
          : await newDebtSession(prompts, input, registry, debt);
    }
    if (step.kind === "end") {
      return step.exitCode === undefined ? exitOf(wrote, completed) : { exitCode: step.exitCode };
    }
    if (step.wrote) wrote = true;
    completed = true;

    const again = await askRunAnother(prompts);
    if (again === null) return exitOf(wrote, completed);
    if (!again) return exitOf(wrote, completed);
  }
}

/** Written and cleanly finished exit 0; an input-exhausted session does not. */
function exitOf(wrote: boolean, completed: boolean): ExceptionAddResult {
  return { exitCode: wrote || completed ? 0 : 1 };
}

/** The session choice. `2` is the renew branch: an in-place edit, never an append. */
async function chooseSession(prompts: Prompter): Promise<"new" | "renew" | null> {
  for (;;) {
    const answer = await prompts.ask("choose — 1 (new debt) or 2 (renew):");
    if (answer === null) return null;
    if (answer === "1") return "new";
    if (answer === "2") return "renew";
    prompts.say("type 1 (new debt) or 2 (renew)");
  }
}

/** `run another session?` — Enter finishes, and a lost line finishes too. */
async function askRunAnother(prompts: Prompter): Promise<boolean | null> {
  return askYesNo(
    prompts,
    "run another session? [y/N]",
    "type y to run another session, or press Enter to finish",
  );
}

/** `write the exception?` — Enter declines, and a declined proposal is never lost. */
async function confirmWrite(prompts: Prompter): Promise<boolean | null> {
  return askYesNo(
    prompts,
    "write the exception? [y/N]",
    "type y to write the exception, or press Enter to leave it unwritten",
  );
}

/**
 * The one `[y/N]` question: Enter is the default `N`, `y`/`yes` accepts, and
 * anything else is refused with this question's own restatement of the two
 * answers. Resolves `null` when the stream ends mid-question — the end of the
 * session, and never a `y` nobody typed. Three of the wizard's questions are
 * this one with different wording, and the grammar that keeps a wrong Enter
 * from becoming a forced `y` has to be the same in all of them.
 */
async function askYesNo(prompts: Prompter, question: string, restatement: string): Promise<boolean | null> {
  for (;;) {
    const answer = await prompts.ask(question);
    if (answer === null) return null;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "" || answer === "n" || answer === "no") return false;
    prompts.say(restatement);
  }
}

// --- the new-debt session ----------------------------------------------------

/**
 * The authoring session both front doors share: the selected suppressions are
 * already known (picked from the debt list, or handed over by a FAIL report),
 * so the interview and the one expiry decision are all that is left. A pick is
 * announced before the interview; a selection that arrived already made was
 * announced by the door that took it, so the transcript states which
 * suppressions the records below it are for exactly once.
 */
async function newDebtSession(
  prompts: Prompter,
  input: SessionInput,
  registry: WorkingRegistry,
  debt: readonly ReconciledSuppression[],
  preselect?: readonly MatchFields[],
): Promise<SessionStep> {
  const { out, now, policy } = input;
  let selected: readonly MatchFields[];
  if (preselect !== undefined) {
    selected = preselect;
  } else {
    if (debt.length === 0) {
      out.write("no new debt from this change requires an exception.\n");
      return { kind: "end", exitCode: 0 };
    }
    for (const [i, s] of debt.entries()) {
      out.write(`  ${i + 1}) ${whereOf(s)}  ${s.rule}  (${s.suppressionType}, ${s.disposition})\n`);
    }
    const picked = await pickSuppressions(prompts, debt);
    if (picked === null) return { kind: "end" };
    announce(prompts, picked);
    selected = picked;
  }

  const details = await interview(prompts, selected);
  if (details === null) return { kind: "end" };

  // The last gate the expiry decision passes: the same refusal the gate states
  // about a newly written over-max date, asked here of the whole proposed
  // registry so no rung of the ladder can write a date the gate would fail.
  const guard: ExpiryGuard = (decision) =>
    expiryRefusal({
      baseline: registry.records,
      head: [...registry.records, ...recordsFor(selected, details, decision)],
      policy,
      now,
    });
  const expiry = await decideExpiry(prompts, policy, now, { guard });
  if (expiry === null) return { kind: "end" };

  const records = recordsFor(selected, details, expiry);
  const proposal = propose(registry.raw, records);
  if (proposal.defects.length > 0) {
    printDefects(out, proposal.defects);
    return { kind: "end", exitCode: 1 };
  }
  printReview(out, records, "new");

  const confirmed = await confirmWrite(prompts);
  if (confirmed === null) return { kind: "end" };
  if (!confirmed) {
    prompts.say("nothing written — the proposed record stays unwritten.");
    return { kind: "done", wrote: false };
  }
  writeRegistry(input.git.root, proposal.text);
  printWritten(out, records, policy);
  return { kind: "done", wrote: true };
}

/** Nothing written, and every defect that refused it, in the report's own spelling. */
function printDefects(out: NodeJS.WritableStream, defects: readonly Finding[]): void {
  out.write("✘ nothing written — defects found\n");
  for (const finding of defects) out.write(`${renderFinding(finding)}\n`);
}

/**
 * The pick step: numbers, one answer, selection order preserved. One
 * `◉ selected` line per suppression follows the answer, so the transcript reads
 * back the selection.
 */
async function pickSuppressions(
  prompts: Prompter,
  debt: readonly ReconciledSuppression[],
): Promise<ReconciledSuppression[] | null> {
  const label =
    debt.length === 1
      ? "select which to record (number — 1):"
      : `select which to record (numbers — e.g. 1, or 1,${debt.length}):`;
  for (;;) {
    const answer = await prompts.ask(label);
    if (answer === null) return null;
    const tokens = answer.split(/[,\s]+/).filter((token) => token !== "");
    const outOfRange = tokens.find(
      (token) => !/^\d+$/.test(token) || Number(token) < 1 || Number(token) > debt.length,
    );
    if (tokens.length === 0 || outOfRange !== undefined) {
      prompts.say(
        debt.length === 1
          ? "pick 1 — it is the only new debt"
          : `pick a number between 1 and ${debt.length} (e.g. "1" or "1,2")`,
      );
      continue;
    }
    const selected: ReconciledSuppression[] = [];
    const seen = new Set<number>();
    for (const token of tokens) {
      const n = Number(token);
      if (seen.has(n)) continue;
      seen.add(n);
      selected.push(debt[n - 1]!);
    }
    return selected;
  }
}

/** One `◉ selected` line per chosen suppression — the same line in both doors. */
function announce(prompts: Prompter, selected: readonly MatchFields[]): void {
  for (const s of selected) {
    prompts.say(`◉ selected  ${whereOf(s)}  ${s.rule}  (${s.suppressionType})`);
  }
}

/** A suppression's location as both the debt list and the selection echo print it. */
function whereOf(fields: { file: string; line?: number }): string {
  return fields.line === undefined ? fields.file : `${fields.file}:${fields.line}`;
}

/**
 * The interview: one detail set for a single selection or a shared one, or a
 * per-record interview in selection order when the selection does not share.
 * A selection of one skips the shared question — there is nothing to share.
 * Answers come back in selection order, one per suppression.
 */
async function interview(
  prompts: Prompter,
  selected: readonly MatchFields[],
): Promise<Detail[] | null> {
  if (selected.length === 1) {
    const detail = await interviewOnce(prompts);
    return detail === null ? null : [detail];
  }
  const share = await askShared(prompts, selected.length);
  if (share === null) return null;
  if (share) {
    const detail = await interviewOnce(prompts);
    return detail === null ? null : selected.map(() => detail);
  }
  return interviewEach(prompts, selected);
}

/** `Do these N exceptions all share one reason?` — Enter shares. */
async function askShared(prompts: Prompter, count: number): Promise<boolean | null> {
  for (;;) {
    const answer = await prompts.ask(`Do these ${count} exceptions all share one reason? [Y/n]`);
    if (answer === null) return null;
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    prompts.say("type y if they all share one reason (asked once), or n to answer per record");
  }
}

/** One detail set: a reason (required) and a reference (optional, Enter skips). */
async function interviewOnce(prompts: Prompter): Promise<Detail | null> {
  const reason = await askReason(prompts, "reason for the exception (required):");
  if (reason === null) return null;
  const reference = await askReference(
    prompts,
    "reference (issue / PR / ticket link) — optional; Enter to skip:",
    "reference (issue / PR / ticket link) — optional: Skipped",
  );
  if (reference === null) return null;
  return { reason, reference };
}

/** The per-record interview, in selection order, each answer carrying file:line. */
async function interviewEach(
  prompts: Prompter,
  selected: readonly MatchFields[],
): Promise<Detail[] | null> {
  const details: Detail[] = [];
  for (const [i, suppression] of selected.entries()) {
    const where = whereOf(suppression);
    const ofN = `for record ${i + 1} of ${selected.length} — ${where}`;
    const reason = await askReason(prompts, `reason ${ofN}:`);
    if (reason === null) return null;
    const reference = await askReference(
      prompts,
      `reference (issue / PR / ticket link) ${ofN} — optional; Enter to skip:`,
      `reference (issue / PR / ticket link) ${ofN} — optional: Skipped`,
    );
    if (reference === null) return null;
    details.push({ reason, reference });
  }
  return details;
}

/** The reason prompt: required — an empty answer is refused, never accepted. */
async function askReason(prompts: Prompter, label: string): Promise<string | null> {
  for (;;) {
    const answer = await prompts.ask(label);
    if (answer === null) return null;
    if (answer !== "") return answer;
    prompts.say("the reason is required — type it (Enter has no meaning here)");
  }
}

/** The reference prompt: optional — Enter skips, and the skip echoes itself. */
async function askReference(
  prompts: Prompter,
  label: string,
  skipEcho: string,
): Promise<string | null> {
  const answer = await prompts.ask(label);
  if (answer === null) return null;
  if (answer === "") prompts.say(skipEcho);
  return answer;
}

// --- the expiry ladder -------------------------------------------------------

/**
 * The last gate a candidate expiry passes before the ladder accepts it: the
 * expiry policy's own refusal about the registry the decision would write, as
 * one line, or null when the write is inside policy. The machinery is the gate's
 * own (`expiryPolicyRefusals`), so a surface that can write a registry can never
 * write one the gate would fail over an expiry.
 */
type ExpiryGuard = (decision: ExpiryDecision) => string | null;

interface ExpiryOptions {
  /** A renewal echoes its accepted date as a new one; a new record as its own. */
  renewal?: boolean;
  guard?: ExpiryGuard;
}

/**
 * The three-rung expiry ladder, one decision for the whole write:
 *
 * 1. accept the prefilled default (Enter accepts, echoes just the date);
 * 2. make it permanent (`y` prints the approver note and proceeds);
 * 3. a date prompt stating the max inline. Past and beyond-max dates are
 *    refused with distinct messages, and after any refusal the permanent
 *    question is re-offered as the escape hatch — declining it returns to the
 *    date prompt.
 *
 * The guard is consulted on rung 1 only, because rungs 2 and 3 are inside the
 * max by construction and a permanent carries no date to refuse.
 */
async function decideExpiry(
  prompts: Prompter,
  policy: Policy,
  now: Date,
  options: ExpiryOptions = {},
): Promise<ExpiryDecision | null> {
  const defaultDate = suggestedExpiry(now, policy.exceptions.defaultExpiry);
  const maxDate = expiryHorizon(now, policy.exceptions.maxExpiry);
  const acceptLabel = `a default expiry of ${defaultDate} (${describeDuration(policy.exceptions.defaultExpiry)} from today) is set — accept it? [Y/n]`;
  for (;;) {
    const answer = await prompts.ask(acceptLabel);
    if (answer === null) return null;
    if (answer === "" || answer === "y" || answer === "yes") {
      const decision: ExpiryDecision = { kind: "temporary", date: defaultDate };
      const refusal = options.guard?.(decision) ?? null;
      if (refusal === null) {
        prompts.say(`${options.renewal === true ? "new expiry" : "expiry"}: ${defaultDate}`);
        return decision;
      }
      // A `defaultExpiry` at the ceiling can round past it, so the prefilled
      // date is refused like any other out-of-policy one, permanent re-offered.
      prompts.say(refusal);
      return await escapeHatch(prompts, defaultDate, maxDate, now, options);
    }
    if (answer === "n" || answer === "no") break;
    prompts.say("type y to accept the default, or n to set your own date / make it permanent");
  }
  return await escapeHatch(prompts, defaultDate, maxDate, now, options);
}

/** Rungs 2 and 3: the permanent question, and the date prompt it can decline. */
async function escapeHatch(
  prompts: Prompter,
  defaultDate: string,
  maxDate: string,
  now: Date,
  options: ExpiryOptions,
): Promise<ExpiryDecision | null> {
  for (;;) {
    const answer = await prompts.ask("make this a permanent exception? [y/N]");
    if (answer === null) return null;
    if (answer === "y" || answer === "yes") {
      prompts.say("permanent exceptions require an approver.");
      prompts.say("expiry: permanent — no expires");
      return { kind: "permanent" };
    }
    if (answer === "" || answer === "n" || answer === "no") {
      const dated = await askDate(prompts, defaultDate, maxDate, now);
      if (dated === null) return null;
      if (dated !== "re-offer-permanent") return dated;
      continue;
    }
    prompts.say("type y for a permanent exception (an approver is required), or n to pick a date");
  }
}

/**
 * The date prompt — one rung, three refusals. A malformed or calendar-invalid
 * date restates the format and asks again; a past or beyond-max date is
 * refused with its own message and escalates to the permanent question.
 */
async function askDate(
  prompts: Prompter,
  defaultDate: string,
  maxDate: string,
  now: Date,
): Promise<ExpiryDecision | "re-offer-permanent" | null> {
  const label = `new expiry — YYYY-MM-DD, no later than ${maxDate}:`;
  for (;;) {
    const answer = await prompts.ask(label);
    if (answer === null) return null;
    if (!isIsoDateForm(answer)) {
      prompts.say(`type a date as YYYY-MM-DD — e.g. ${defaultDate}, up to ${maxDate}`);
      continue;
    }
    if (!isCalendarDate(answer)) {
      prompts.say(`not a real date — use YYYY-MM-DD (e.g. ${defaultDate}), up to ${maxDate}`);
      continue;
    }
    // ISO dates compare lexicographically; today itself is valid through its
    // end of day, so "past" is strictly before it.
    if (answer < isoDay(now)) {
      prompts.say(`✘ ${answer} is in the past. Choose a future date no later than ${maxDate}, or make it permanent.`);
      return "re-offer-permanent";
    }
    if (answer > maxDate) {
      prompts.say(`✘ ${answer} is later than the max (${maxDate}). Choose a date no later than ${maxDate}, or make it permanent.`);
      return "re-offer-permanent";
    }
    prompts.say(`expiry: change → ${answer}`);
    return { kind: "temporary", date: answer };
  }
}

/**
 * The expiry policy's refusal of one proposed registry, as one transcript line —
 * the gate's own message, under the code the gate raises it as, so the author
 * reads the same sentence CI will read. Exported as the unit seam for the net
 * itself: the ladder's date prompt refuses an out-of-policy date before a
 * decision ever reaches here, so the only reproducible way to exercise this
 * predicate is to ask it directly, the way a rendered report's TTY branch is
 * asked for.
 */
export function expiryRefusal(input: {
  baseline: readonly ExceptionRecord[];
  head: readonly ExceptionRecord[];
  policy: Policy;
  now: Date;
}): string | null {
  const maxExpiry = input.policy.exceptions.maxExpiry;
  const refused = expiryPolicyRefusals({
    baseline: input.baseline,
    head: input.head,
    now: input.now,
    maxExpiry,
  })[0];
  if (refused === undefined) return null;
  return `✘ EXPIRY_POLICY — ${expiryPolicyMessage(refused, maxExpiry, input.now)}`;
}

// --- the renew session -------------------------------------------------------

/** One record a renewal can edit, with the registry position it is edited at. */
interface Renewable {
  /** 1-based entry in the registry, the position the edit is applied at. */
  readonly index: number;
  readonly record: ExceptionRecord;
}

/**
 * The records a renewal can edit: every temporary record, each with the expiry
 * it currently carries — including one that has already lapsed, which is the
 * record most in need of renewing. Temporaries only — a permanent carries no
 * date to renew, and turning one back into a temporary is a different edit than
 * the one this branch offers.
 */
function renewable(entries: readonly RegistryEntry[]): Renewable[] {
  return entries
    .filter((entry) => entry.record.expires !== undefined)
    .map((entry) => ({ index: entry.index, record: entry.record }));
}

/**
 * The renew session: pick an existing record, edit its `expires` where it is
 * written, and write nothing else. A renewal is a policy change — it moves a
 * horizon the gate will judge — so it takes fresh authorization on the protected
 * track in both landing modes, and prior approval never carries forward.
 */
async function renewSession(
  prompts: Prompter,
  input: SessionInput,
  registry: WorkingRegistry,
): Promise<SessionStep> {
  const { out, now, policy } = input;
  const candidates = renewable(registry.entries);
  if (candidates.length === 0) {
    prompts.say(
      "no temporary record in this registry to renew — a renewal edits an existing record's expires in place.",
    );
    return { kind: "end", exitCode: 0 };
  }
  out.write("→ renewal — expiring record:\n");
  for (const [i, candidate] of candidates.entries()) {
    out.write(`  ${i + 1}) ${renewalLine(candidate, now)}\n`);
  }
  const chosen = await pickRenewal(prompts, candidates);
  if (chosen === null) return { kind: "end" };
  // The record the renewal is about, named back: the pick said a number, this
  // says which file and line that number stood for, so the interview that
  // follows is about something the author can see.
  prompts.say(`⤷ renewing ${chosen.record.rule} @ ${whereOf(chosen.record)}`);

  // The renewal is held to the same expiry policy as any other write, judged
  // against the registry it is about to become: a renewed date past the baseline
  // max is a refusal (`EXPIRY_POLICY`), and the permanent question is re-offered
  // as the escape hatch, exactly as a beyond-max date is at the date prompt.
  const guard: ExpiryGuard = (decision) =>
    expiryRefusal({
      baseline: registry.records,
      head: registry.records.map((record) =>
        record === chosen.record ? applyExpiry(record, decision) : record,
      ),
      policy,
      now,
    });
  const expiry = await decideExpiry(prompts, policy, now, { renewal: true, guard });
  if (expiry === null) return { kind: "end" };

  const text = editFields(registry.raw ?? "", chosen.index, expiryEdits(expiry));
  if (text === null) {
    out.write("✘ nothing written — the registry's own shape refused the edit\n");
    return { kind: "end", exitCode: 1 };
  }
  const defects = defectsOf(validateRegistry(text).findings);
  if (defects.length > 0) {
    printDefects(out, defects);
    return { kind: "end", exitCode: 1 };
  }
  const record = applyExpiry(chosen.record, expiry);
  printReview(out, [record], "renewal");

  const confirmed = await confirmWrite(prompts);
  if (confirmed === null) return { kind: "end" };
  if (!confirmed) {
    prompts.say("nothing written — the proposed record stays unwritten.");
    return { kind: "done", wrote: false };
  }
  writeRegistry(input.git.root, text);
  printRenewed(out, record);
  return { kind: "done", wrote: true };
}

/** The pick step for a renewal: one existing record, chosen by number. */
async function pickRenewal(
  prompts: Prompter,
  candidates: readonly Renewable[],
): Promise<Renewable | null> {
  const label =
    candidates.length === 1
      ? "select which to renew (number — 1):"
      : `select which to renew (number — 1 to ${candidates.length}):`;
  for (;;) {
    const answer = await prompts.ask(label);
    if (answer === null) return null;
    if (/^\d+$/.test(answer)) {
      const n = Number(answer);
      if (n >= 1 && n <= candidates.length) return candidates[n - 1]!;
    }
    prompts.say(
      candidates.length === 1
        ? "pick 1 — it is the only expiring record"
        : `pick a number between 1 and ${candidates.length}`,
    );
  }
}

/** One line per renewable: the record's location and the horizon it carries today. */
function renewalLine(candidate: Renewable, now: Date): string {
  const { record } = candidate;
  return `${record.rule} @ ${whereOf(record)} — expires ${record.expires} (${remaining(record.expires!, now)})`;
}

/** How long a date still has, in the plainest words the list can carry. */
function remaining(expires: string, now: Date): string {
  const days = daysBetween(isoDay(now), expires);
  if (days === 0) return "today";
  if (days > 0) return `in ${days}d`;
  return `expired ${-days}d ago`;
}

/** The write's own shape, as field edits: a new date, or a date gone with its type. */
function expiryEdits(expiry: ExpiryDecision): FieldEdit[] {
  return expiry.kind === "temporary"
    ? [{ field: "expires", value: expiry.date }]
    : [
        { field: "type", value: "permanent" },
        { field: "expires", value: null },
      ];
}

// --- the non-interactive session ---------------------------------------------

/**
 * The scripted session: flags carry the human answers, `--from` selects the
 * suppression, the expiry prefills from the policy default, and the same
 * validation, review, and write run with no prompts at all.
 */
async function scriptedSession(
  input: SessionInput,
  options: ExceptionAddOptions,
): Promise<ExceptionAddResult> {
  const { out, error } = input;
  const selector = parseFrom(options.from!);
  if (selector === null) {
    error.write(`--from expects <file>:<line> — got '${options.from}'\n`);
    return { exitCode: 1 };
  }
  if (!options.reason) {
    error.write("the reason is required — pass it with --reason <text>\n");
    return { exitCode: 1 };
  }

  const registry = readRegistry(input.git.root, out);
  if ("exitCode" in registry) return { exitCode: registry.exitCode };
  const debt = await readDebt({ ...input, records: registry.records });
  const matches = debt.filter((s) => s.file === selector.file && s.line === selector.line);
  if (matches.length === 0) {
    error.write(`no new debt at ${options.from}\n`);
    return { exitCode: 1 };
  }
  if (matches.length > 1) {
    error.write(
      `${matches.length} suppressions sit at ${options.from} — --from cannot choose between them; record them in an interactive session\n`,
    );
    return { exitCode: 1 };
  }

  const detail: Detail = {
    reason: options.reason,
    reference: options.reference ?? "",
  };
  const expiry: ExpiryDecision = {
    kind: "temporary",
    date: suggestedExpiry(input.now, input.policy.exceptions.defaultExpiry),
  };
  const records = [recordFor(matches[0]!, detail, expiry)];
  const proposal = propose(registry.raw, records);
  if (proposal.defects.length > 0) {
    printDefects(out, proposal.defects);
    return { exitCode: 1 };
  }
  printReview(out, records, "new");
  writeRegistry(input.git.root, proposal.text);
  printWritten(out, records, input.policy);
  return { exitCode: 0 };
}

/** `--from` as a file and a line, or null when it is neither. */
function parseFrom(from: string): { file: string; line: number } | null {
  const colon = from.lastIndexOf(":");
  if (colon <= 0) return null;
  const line = from.slice(colon + 1);
  if (!/^\d+$/.test(line) || Number(line) < 1) return null;
  return { file: from.slice(0, colon), line: Number(line) };
}

// --- the proposal, the write, and the transcript ------------------------------

/** The machine-authored records for one write, in selection order. */
function recordsFor(
  selected: readonly MatchFields[],
  details: readonly Detail[],
  expiry: ExpiryDecision,
): ExceptionRecord[] {
  return selected.map((fields, i) => recordFor(fields, details[i]!, expiry));
}

/**
 * One machine-authored record: match fields from the inventory, the rest from the
 * interview, in the registry's canonical field order — which is why this builds
 * the object rather than spreading a lifecycle decision into it (that is
 * `applyExpiry`'s job, for a record that already exists). The order is the
 * format's, so the bytes the append path writes are the bytes a hand-written
 * record of the same fields would be.
 */
function recordFor(
  fields: MatchFields,
  detail: Detail,
  expiry: ExpiryDecision,
): ExceptionRecord {
  return {
    rule: fields.rule,
    suppression_type: fields.suppressionType,
    fingerprint: fields.fingerprint,
    file: fields.file,
    type: expiry.kind,
    reason: detail.reason,
    ...(detail.reference === "" ? {} : { reference: detail.reference }),
    ...(expiry.kind === "temporary" ? { expires: expiry.date } : {}),
    ...(fields.line === undefined ? {} : { line: fields.line }),
  };
}

/**
 * A record with its lifecycle half not yet decided. The shape a record is built
 * in before one expiry decision turns it into a record: the format forbids
 * `expires` on a permanent and requires it on a temporary, so the two fields
 * move together and neither can be set without the other.
 */
type RecordLifecycleOmitted = Omit<ExceptionRecord, "type" | "expires">;

/** A record with its lifecycle half not yet decided, or one that already carries it. */
type ExpiryTarget = RecordLifecycleOmitted & Pick<ExceptionRecord, "expires">;

/**
 * The record that carries one expiry decision: the type the decision implies, and
 * the date it carries or the absence of one. The lifecycle's whole shape, in one
 * place — a renewal is a decision applied to a record that exists, so this is the
 * only place the two fields move together, and a record can never be left
 * carrying a permanent's type with a temporary's date (a shape the format calls a
 * defect).
 */
function applyExpiry(record: ExpiryTarget, expiry: ExpiryDecision): ExceptionRecord {
  if (expiry.kind === "temporary") {
    return { ...record, type: "temporary", expires: expiry.date };
  }
  // Permanent: the date goes with the type, so a record is never left carrying both.
  const { expires: _dropped, ...rest } = record;
  return { ...rest, type: "permanent" };
}

/** A record's horizon as the transcript states it — one spelling, three call sites. */
function horizonOf(record: ExceptionRecord): string {
  return record.type === "temporary" ? `expires ${record.expires}` : "permanent";
}

/** A validated proposal: the combined registry text, and the defects refusing it. */
function propose(
  registryRaw: string | null,
  records: readonly ExceptionRecord[],
): { text: string; defects: ReturnType<typeof defectsOf> } {
  const text = combineRegistry(registryRaw, records);
  return { text, defects: defectsOf(validateRegistry(text).findings) };
}

/**
 * The write's shape: the new records appended to the existing raw text, never
 * a reserialization of it — the records an author did not touch keep their
 * bytes, their order, and their comments. (A renewal never comes through here:
 * it edits the record it names, so the pool it belongs to keeps its size.)
 */
function combineRegistry(existing: string | null, records: readonly ExceptionRecord[]): string {
  const appended = records
    .map((record) => stringify([record], { lineWidth: 0 }))
    .join("");
  if (existing === null || existing.trim().length === 0) return appended;
  return existing.endsWith("\n") ? existing + appended : `${existing}\n${appended}`;
}

/** The registry file, created on the first record the repo ever lands. */
function writeRegistry(root: string, text: string): void {
  const target = join(root, PROTECTED_REGISTRY);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf8");
}

/**
 * The review block: one bullet per record, match fields in one line, the
 * human answers under the first bullet that carries them — a shared answer is
 * printed once, a per-record one under each record that gave it. A renewal's
 * bullet says so, and carries the reason and reference the record keeps: the
 * review is the record as it will read after the edit.
 */
function printReview(
  out: NodeJS.WritableStream,
  records: readonly ExceptionRecord[],
  marker: "new" | "renewal",
): void {
  out.write("Review — the record(s) to write:\n");
  const first = records[0]!;
  const shared = records.every(
    (r) => r.reason === first.reason && (r.reference ?? "") === (first.reference ?? ""),
  );
  for (const [i, record] of records.entries()) {
    const horizon = horizonOf(record);
    out.write(
      `  • ${record.rule} @ ${whereOf(record)} — ${record.suppression_type} (${marker}) — ${horizon}\n`,
    );
    if (shared && i > 0) continue;
    out.write(`    reason:    ${record.reason}\n`);
    if (record.reference) out.write(`    reference: ${record.reference}\n`);
  }
}

/**
 * The write's confirmation: what was written, that it is a proposal, and the
 * landing guidance the repo's baseline posture earns — the two Next steps of
 * the strict two-step, or nothing where combined landing lets the record ride
 * the change it authorizes.
 */
function printWritten(
  out: NodeJS.WritableStream,
  records: readonly ExceptionRecord[],
  policy: Policy,
): void {
  out.write(
    `✎ exception record${records.length > 1 ? "s" : ""} written to ${PROTECTED_REGISTRY}\n`,
  );
  out.write("it takes effect only once the change is approved and merged.\n");
  if (!policy.allowSameChangeExceptions) {
    out.write("\nNext steps\n");
    out.write("  1. land the record in its own PR — an approver reviews and merges it\n");
    out.write("  2. once merged, land the code change that adds the suppression\n");
  }
}

/**
 * The renewal's confirmation, and the guidance that follows it. A renewal never
 * rides the change it authorizes in either landing mode: it moves a horizon
 * every later evaluation judges by, so the approval that covers the original
 * record does not cover this one. Protected track, fresh authorization, both
 * modes — which is why these two steps print where a new record's do not.
 */
function printRenewed(out: NodeJS.WritableStream, record: ExceptionRecord): void {
  // The date itself, not `expires <date>`: this line states what the record's
  // expiry *is now*, and the review bullet above it is where the field is named.
  const horizon = record.type === "temporary" ? record.expires! : "permanent";
  out.write(`✎ the existing record's expiry is now ${horizon}\n`);
  out.write("it takes effect only once the change is approved and merged.\n");
  out.write("\nNext steps\n");
  out.write("  1. the renewal updates the existing record's expiry in place\n");
  out.write("  2. submit it in a PR — an approver reviews and merges it\n");
}

// --- the prompter -------------------------------------------------------------

/**
 * The prompt engine: a label per question, the typed answer echoed under it
 * as `❯ answer`, and Enter answering with the prompt's default (echoing
 * nothing typed — the caller echoes the resolved value). Built over readline
 * for terminal line editing, with our own line queue: `readline`'s own
 * `question` drops every line that arrives while no question is pending,
 * which a fully-buffered scripted session would lose.
 */
class Prompter {
  private readonly rl: ReadlineInterface;
  private readonly lines: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    this.rl = createInterface({ input, output });
    this.rl.on("line", (line: string) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  /**
   * One question. Resolves the trimmed answer, `""` for Enter, or null when the
   * prompt stream ended — input exhausted is the end of the session, never
   * a default anyone chose.
   */
  async ask(label: string): Promise<string | null> {
    this.output.write(`${label}\n`);
    const line =
      this.lines.length > 0
        ? this.lines.shift()!
        : this.closed
          ? null
          : await new Promise<string | null>((resolve) => this.waiters.push(resolve));
    if (line === null || line === undefined) return null;
    const answer = line.trim();
    if (answer !== "") this.output.write(`❯ ${answer}\n`);
    return answer;
  }

  /** One transcript line from within the interview — the prompter owns the pen. */
  say(line: string): void {
    this.output.write(`${line}\n`);
  }

  /** Releases the terminal: a live readline on a TTY would hold the process open. */
  close(): void {
    this.rl.close();
  }
}
