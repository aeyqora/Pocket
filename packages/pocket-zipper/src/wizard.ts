import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { EMPTY_TREE, Git } from "./git.js";
import { EslintSession } from "./eslint.js";
import { configPluginRuleNames } from "./recognize.js";
import { analyzeTrees, reconcileGoverned } from "./pipeline.js";
import {
  describeDuration,
  expiryHorizon,
  isoDay,
  parsePolicy,
  suggestedExpiry,
} from "./policy.js";
import { coverExceptions } from "./registry.js";
import { readIfPresent } from "./validate-command.js";
import {
  PROTECTED_CONFIG,
  PROTECTED_REGISTRY,
  defectsOf,
  documentDefect,
  isCalendarDate,
  isIsoDateForm,
  renderFinding,
  validateRegistry,
  type Finding,
} from "./validate.js";
import { PocketZipperError } from "./errors.js";
import type { ExceptionRecord, Policy, ReconciledSuppression } from "./types.js";

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
  const now = options.now ?? new Date();
  const out = options.output ?? process.stdout;
  const error = options.stderr ?? process.stderr;

  try {
    const git = await Git.discover(options.cwd);
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

      return options.from !== undefined
        ? await scriptedSession({
            git,
            policy,
            baselineCommit,
            baselineDir,
            baselineSession,
            headSession,
            now,
            out,
            error,
            from: options.from,
            reason: options.reason,
            reference: options.reference,
          })
        : await interactiveSessions({
            git,
            policy,
            baselineCommit,
            baselineDir,
            baselineSession,
            headSession,
            now,
            out,
            input: options.input ?? process.stdin,
          });
    } finally {
      git.cleanup(baselineDir);
    }
  } catch (err) {
    if (err instanceof PocketZipperError) {
      error.write(`${err.message}\n`);
      return { exitCode: 2 };
    }
    error.write(`pocket-zipper: internal error: ${err instanceof Error ? err.message : String(err)}\n`);
    return { exitCode: 2 };
  }
}

// --- the session's shared reads ---------------------------------------------

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
}

/**
 * The working-tree registry, fail-closed like every registry read: a defect
 * prints its diagnostics and refuses the session (exit 2); a file that is
 * genuinely not there is an empty registry the write will create.
 */
function readRegistry(
  root: string,
  out: NodeJS.WritableStream,
): { raw: string | null; records: ExceptionRecord[] } | { exitCode: number } {
  let raw: string | null;
  try {
    raw = readIfPresent(root, PROTECTED_REGISTRY);
  } catch (err) {
    // A registry this session cannot read is a defect, not an absent one.
    out.write(
      `${renderFinding(documentReadDefect(err))}\n`,
    );
    return { exitCode: 2 };
  }
  const validation = validateRegistry(raw);
  const defects = defectsOf(validation.findings);
  if (defects.length > 0) {
    for (const finding of defects) out.write(`${renderFinding(finding)}\n`);
    return { exitCode: 2 };
  }
  return { raw, records: validation.entries.map((entry) => entry.record) };
}

/** A protected document that could not be read, as one defect finding. */
function documentReadDefect(err: unknown): Finding {
  const code = (err as { code?: string } | null)?.code ?? "unknown error";
  return documentDefect(PROTECTED_REGISTRY, `the document could not be read (${code})`);
}

/**
 * The working tree's new debt — the FAIL report's flagged list, recomputed for
 * the tree instead of a merge: governed directive-form suppressions the change
 * introduces, that no record in the working-tree registry covers. The
 * working-tree registry is the honest coverage for a working-tree surface, so
 * a record a previous wizard session wrote takes its suppression off this list
 * on the next pass.
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
  });
  const { head } = reconcileGoverned({ policy, analysis });
  const coverage = coverExceptions({ head, records, now });
  return coverage.head.filter(
    (h) =>
      (h.disposition === "new" || h.disposition === "materially-changed") &&
      h.guardKind === "directive" &&
      h.exception === null,
  );
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
 * One command invocation, zero or more sessions: `run another session?` loops
 * back to the top, recomputing the registry and the debt list against the
 * tree as the previous session left it.
 */
async function interactiveSessions(
  input: SessionInput & { input: NodeJS.ReadableStream },
): Promise<ExceptionAddResult> {
  const prompts = new Prompter(input.input, input.out);
  try {
    let wrote = false;
    let completed = false;
    sessionLoop: for (;;) {
      const { out } = input;
      out.write("reading the working tree's new debt…\n");
      const registry = readRegistry(input.git.root, out);
      if ("exitCode" in registry) return { exitCode: registry.exitCode };

      const debt = await readDebt({ ...input, records: registry.records });
      out.write("this session is for:\n");
      out.write("  1) new debt from this change\n");
      out.write("  2) renew an expiring record\n");

      // The session choice. The renew branch arrives with its own ticket; the
      // offer is honest about it and takes the choice again.
      for (;;) {
        const choice = await prompts.ask("choose — 1 (new debt) or 2 (renew):");
        if (choice === null) return exitOf(wrote, completed);
        if (choice === "1") break;
        if (choice === "2") {
          out.write("renew is not available yet\n");
          continue;
        }
        out.write("type 1 (new debt) or 2 (renew)\n");
      }
      out.write("→ new debt\n");
      if (debt.length === 0) {
        out.write("no new debt from this change requires an exception.\n");
        return { exitCode: 0 };
      }
      for (const [i, s] of debt.entries()) {
        out.write(`  ${i + 1}) ${s.file}:${s.line}  ${s.rule}  (${s.suppressionType}, ${s.disposition})\n`);
      }

      const selected = await pickSuppressions(prompts, debt);
      if (selected === null) return exitOf(wrote, completed);
      const details = await interview(prompts, selected);
      if (details === null) return exitOf(wrote, completed);
      const expiry = await decideExpiry(prompts, input.policy, input.now);
      if (expiry === null) return exitOf(wrote, completed);

      const records = selected.map((suppression) =>
        recordFor(suppression, details.get(suppression)!, expiry),
      );
      const proposal = propose(registry.raw, records);
      if (proposal.defects.length > 0) {
        out.write("✘ nothing written — defects found\n");
        for (const finding of proposal.defects) out.write(`${renderFinding(finding)}\n`);
        return { exitCode: 1 };
      }
      printReview(out, records);

      // The write prompt: Enter declines — a proposal is declined, never lost.
      let declined = false;
      for (;;) {
        const answer = await prompts.ask("write the exception? [y/N]");
        if (answer === null) return exitOf(wrote, completed);
        if (answer === "y" || answer === "yes") break;
        if (answer === "" || answer === "n" || answer === "no") {
          out.write("nothing written — the proposed record stays unwritten.\n");
          declined = true;
          break;
        }
        out.write("type y to write the exception, or press Enter to leave it unwritten\n");
      }
      if (!declined) {
        writeRegistry(input.git.root, proposal.text);
        printWritten(out, records, input.policy);
        wrote = true;
      }
      completed = true;

      for (;;) {
        const answer = await prompts.ask("run another session? [y/N]");
        if (answer === null) return exitOf(wrote, completed);
        if (answer === "" || answer === "n" || answer === "no") return exitOf(wrote, completed);
        if (answer === "y" || answer === "yes") continue sessionLoop;
        out.write("type y to run another session, or press Enter to finish\n");
      }
    }
  } finally {
    prompts.close();
  }
}

/** Written and cleanly finished exit 0; an input-exhausted session does not. */
function exitOf(wrote: boolean, completed: boolean): ExceptionAddResult {
  return { exitCode: wrote || completed ? 0 : 1 };
}

/**
 * The pick step: numbers, one answer, selection order preserved. Echoes one
 * `◉ selected` line per suppression, so the transcript reads back the selection.
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
      const suppression = debt[n - 1]!;
      selected.push(suppression);
      prompts.say(
        `◉ selected  ${suppression.file}:${suppression.line}  ${suppression.rule}  (${suppression.suppressionType})`,
      );
    }
    return selected;
  }
}

/**
 * The interview: one detail set for a single selection or a shared one, or a
 * per-record interview in selection order when the selection does not share.
 * A selection of one skips the shared question — there is nothing to share.
 */
async function interview(
  prompts: Prompter,
  selected: readonly ReconciledSuppression[],
): Promise<Map<ReconciledSuppression, Detail> | null> {
  if (selected.length === 1) {
    const detail = await interviewOnce(prompts);
    if (detail === null) return null;
    return new Map(selected.map((s) => [s, detail]));
  }
  const share = await askShared(prompts, selected.length);
  if (share === null) return null;
  if (share) {
    const detail = await interviewOnce(prompts);
    if (detail === null) return null;
    return new Map(selected.map((s) => [s, detail]));
  }
  return interviewEach(prompts, selected);
}

/** `Do these N exceptions all share one reason?` — Enter shares. */
async function askShared(
  prompts: Prompter,
  count: number,
): Promise<boolean | null> {
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
  selected: readonly ReconciledSuppression[],
): Promise<Map<ReconciledSuppression, Detail> | null> {
  const details = new Map<ReconciledSuppression, Detail>();
  for (const [i, suppression] of selected.entries()) {
    const where = `${suppression.file}:${suppression.line}`;
    const ofN = `for record ${i + 1} of ${selected.length} — ${where}`;
    const reason = await askReason(prompts, `reason ${ofN}:`);
    if (reason === null) return null;
    const reference = await askReference(
      prompts,
      `reference (issue / PR / ticket link) ${ofN} — optional; Enter to skip:`,
      `reference (issue / PR / ticket link) ${ofN} — optional: Skipped`,
    );
    if (reference === null) return null;
    details.set(suppression, { reason, reference });
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

/**
 * The three-rung expiry ladder, one decision for the whole write:
 *
 * 1. accept the prefilled default (Enter accepts, echoes just the date);
 * 2. make it permanent (`y` prints the approver note and proceeds);
 * 3. a date prompt stating the max inline. Past and beyond-max dates are
 *    refused with distinct messages, and after any refusal the permanent
 *    question is re-offered as the escape hatch — declining it returns to the
 *    date prompt.
 */
async function decideExpiry(
  prompts: Prompter,
  policy: Policy,
  now: Date,
): Promise<ExpiryDecision | null> {
  const defaultDate = suggestedExpiry(now, policy.exceptions.defaultExpiry);
  const maxDate = expiryHorizon(now, policy.exceptions.maxExpiry);
  const acceptLabel = `a default expiry of ${defaultDate} (${describeDuration(policy.exceptions.defaultExpiry)} from today) is set — accept it? [Y/n]`;
  for (;;) {
    const answer = await prompts.ask(acceptLabel);
    if (answer === null) return null;
    if (answer === "" || answer === "y" || answer === "yes") {
      prompts.say(`expiry: ${defaultDate}`);
      return { kind: "temporary", date: defaultDate };
    }
    if (answer === "n" || answer === "no") break;
    prompts.say("type y to accept the default, or n to set your own date / make it permanent");
  }
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

// --- the non-interactive session ---------------------------------------------

/**
 * The scripted session: flags carry the human answers, `--from` selects the
 * suppression, the expiry prefills from the policy default, and the same
 * validation, review, and write run with no prompts at all.
 */
async function scriptedSession(
  input: SessionInput & {
    error: NodeJS.WritableStream;
    from: string;
    reason?: string;
    reference?: string;
  },
): Promise<ExceptionAddResult> {
  const { out, error } = input;
  const selector = parseFrom(input.from);
  if (selector === null) {
    error.write(`--from expects <file>:<line> — got '${input.from}'\n`);
    return { exitCode: 1 };
  }
  if (!input.reason) {
    error.write("the reason is required — pass it with --reason <text>\n");
    return { exitCode: 1 };
  }

  const registry = readRegistry(input.git.root, out);
  if ("exitCode" in registry) return { exitCode: registry.exitCode };
  const debt = await readDebt({ ...input, records: registry.records });
  const matches = debt.filter((s) => s.file === selector.file && s.line === selector.line);
  if (matches.length === 0) {
    error.write(`no new debt at ${input.from}\n`);
    return { exitCode: 1 };
  }
  if (matches.length > 1) {
    error.write(
      `${matches.length} suppressions sit at ${input.from} — --from cannot choose between them; record them in an interactive session\n`,
    );
    return { exitCode: 1 };
  }

  const detail: Detail = {
    reason: input.reason,
    reference: input.reference ?? "",
  };
  const expiry: ExpiryDecision = {
    kind: "temporary",
    date: suggestedExpiry(input.now, input.policy.exceptions.defaultExpiry),
  };
  const records = [recordFor(matches[0]!, detail, expiry)];
  const proposal = propose(registry.raw, records);
  if (proposal.defects.length > 0) {
    out.write("✘ nothing written — defects found\n");
    for (const finding of proposal.defects) out.write(`${renderFinding(finding)}\n`);
    return { exitCode: 1 };
  }
  printReview(out, records);
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

/** One machine-authored record: match fields from the inventory, the rest from the interview. */
function recordFor(
  suppression: ReconciledSuppression,
  detail: Detail,
  expiry: ExpiryDecision,
): ExceptionRecord {
  return {
    rule: suppression.rule,
    suppression_type: suppression.suppressionType,
    fingerprint: suppression.fingerprint,
    file: suppression.file,
    type: expiry.kind,
    reason: detail.reason,
    ...(detail.reference === "" ? {} : { reference: detail.reference }),
    ...(expiry.kind === "temporary" ? { expires: expiry.date } : {}),
    line: suppression.line,
  };
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
 * bytes, their order, and their comments.
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
 * printed once, a per-record one under each record that gave it.
 */
function printReview(out: NodeJS.WritableStream, records: readonly ExceptionRecord[]): void {
  out.write("Review — the record(s) to write:\n");
  const first = records[0]!;
  const shared = records.every(
    (r) => r.reason === first.reason && (r.reference ?? "") === (first.reference ?? ""),
  );
  for (const [i, record] of records.entries()) {
    const horizon = record.type === "temporary" ? `expires ${record.expires}` : "permanent";
    out.write(`  • ${record.rule} @ ${record.file}:${record.line} — ${record.suppression_type} (new) — ${horizon}\n`);
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
   * One question. Resolves the trimmed answer, `""` for Enter, or null when
   * the prompt stream ended — input exhausted is the end of the session, never
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
