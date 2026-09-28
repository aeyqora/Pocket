import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Git, EMPTY_TREE } from "./git.js";
import { EslintSession } from "./eslint.js";
import {
  configPluginRuleNames,
  configSeverityLevels,
  recognizeConfigOffs,
  recognizeFile,
  type ConfigSeverityLevel,
} from "./recognize.js";
import { computeGovernedSet, expiryHorizon, parsePolicy, suggestedExpiry } from "./policy.js";
import { coverExceptions, expiryPolicyRefusals, overlongRecords } from "./registry.js";
import {
  PROTECTED_CONFIG,
  PROTECTED_REGISTRY,
  errorRecords,
  loadRegistry,
} from "./validate.js";
import { detectPolicyChange, type PolicyChangeResult } from "./policy-change.js";
import { buildRecord, excludedRecord, failureRecord, summarize } from "./record.js";
import {
  canonicalCodeLine,
  canonicalMovementLine,
  diffLineIndices,
  type LineDiff,
} from "./identity.js";
import { reconcile } from "./reconcile.js";
import { PocketZipperError, gitError } from "./errors.js";
import type {
  DurationLiteral,
  ErrorCode,
  EvaluationRecord,
  ExceptionRecord,
  LogicalSuppression,
  Mode,
  RecordError,
  SuppressionType,
} from "./types.js";

export { TOOL_NAME, TOOL_VERSION, SCHEMA_VERSION } from "./record.js";

const SKIP_PREFIXES = [".git/", "node_modules/", ".pocket-zipper/"];

export interface EvaluateOptions {
  mode: Mode;
  cwd: string;
  baseRef: string;
  now?: Date;
}

export interface EvaluateResult {
  record: EvaluationRecord;
  exitCode: number;
  report: string;
  /**
   * The concrete `expires` a remediation block should suggest: this
   * evaluation's date plus the baseline policy's `defaultExpiry`. Undefined
   * when no remediation block can be printed — nothing was flagged, or the
   * gate is disabled, or the run failed before a policy was read.
   */
  suggestedExpiry: string | undefined;
  /**
   * The baseline policy's `maxExpiry`, the ceiling the overlong count and every
   * expiry refusal were judged against. The renderer names it; it never
   * resolves one. Undefined only when the run failed before a policy was read,
   * where nothing is overlong to name.
   */
  maxExpiry: DurationLiteral | undefined;
}

export async function evaluate(options: EvaluateOptions): Promise<EvaluateResult> {
  const now = options.now ?? new Date();
  const errors: RecordError[] = [];

  try {
    const git = await Git.discover(options.cwd);
    assertGitPosture(git, options.mode);

    const trees = resolveTrees(git, options);

    // The effective policy is the baseline's and shapes whether anything is
    // evaluated at all. Read it before touching ESLint so `enabled: false`
    // genuinely evaluates nothing.
    const baselinePolicyRaw = git.fileAt(trees.baselineCommit, PROTECTED_CONFIG);
    const initialPolicy = parsePolicy(baselinePolicyRaw, new Set());
    if (!initialPolicy.enabled) {
      return {
        record: excludedRecord({
          mode: options.mode,
          baseline: { ref: trees.baselineRef, tree: trees.baselineTree },
          proposedTree: trees.proposedTree,
          policy: initialPolicy,
        }),
        exitCode: 0,
        report: "",
        suggestedExpiry: undefined,
        maxExpiry: initialPolicy.exceptions.maxExpiry,
      };
    }

    const baselineDir = git.materialize(trees.baselineCommit);
    const headDir = resolveHeadDir(git, options, trees);
    const tmpDirs = [baselineDir, ...(headDir === git.root ? [] : [headDir])];

    try {
      const baselineSession = await EslintSession.create(baselineDir);
      const headSession = await EslintSession.create(headDir);
      const knownRules = headSession.coreRuleNames();
      for (const treeDir of [baselineDir, headDir]) {
        for (const name of await configPluginRuleNames(treeDir)) knownRules.add(name);
      }

      const baselineRegistryRaw = git.fileAt(trees.baselineCommit, PROTECTED_REGISTRY);
      const policy = parsePolicy(baselinePolicyRaw, knownRules);
      const registry = loadRegistry(baselineRegistryRaw);

      const changeMap =
        options.mode === "pre-commit"
          ? git.stagedChangeMap()
          : git.changeMap(trees.baselineCommit, trees.headCommit!);

      // The trigger: the policy-change signal and the expiry refusal fire only
      // when the change itself touched one of the two `.pocket-zipper` files.
      // A protected file the change does not carry is not part of the change —
      // most importantly, the pre-commit staged index is not judged by a
      // worktree registry the change never staged. The ESLint-severity surface
      // keeps its own structural gate, so it is not gated here.
      const protectedTouched =
        changeMap.files.has(PROTECTED_CONFIG) || changeMap.files.has(PROTECTED_REGISTRY);

      const analysis = await analyzeTrees({
        git,
        options,
        trees,
        baselineDir,
        headDir,
        baselineSession,
        headSession,
        changeMap,
      });

      const governedHead = computeGovernedSet(policy, analysis.applicableHead);
      const governedBaseline = computeGovernedSet(policy, analysis.applicableBaseline);

      const baselineSuppressions = analysis.baselineSuppressions.filter((s) =>
        governedBaseline.includes(s.rule),
      );
      const headSuppressions = analysis.headSuppressions.filter((s) =>
        governedHead.includes(s.rule),
      );

      const { head, removed: baseline } = reconcile({
        headSuppressions,
        baselineSuppressions,
        lineDiffs: analysis.lineDiffs,
        baselineIndex: analysis.baselineIndex,
        headIndex: analysis.headIndex,
      });

      const coverage = coverExceptions({ head, records: registry, now });
      // Overlong is hygiene over the *baseline* registry, like every other
      // cleanup counter: a landed date past the maximum still authorizes and is
      // counted, and a change that newly writes one is refused below. Derived
      // here, not in `validate`, so the report reads the evaluation's own
      // statuses (expired wins) — while `pocket-zipper validate` lints the
      // working tree and so reads the *head* policy's maximum. That divergence
      // is correct: the two commands answer different questions.
      const overlong = overlongRecords({
        records: registry,
        statuses: coverage.statuses,
        now,
        maxExpiry: policy.exceptions.maxExpiry,
      });
      const cleanup = {
        expired: coverage.counts.expired,
        dangling: coverage.counts.dangling,
        spent: coverage.counts.spent,
        overlong: overlong.length,
      };

      const summary = summarize(coverage.head, baseline.length);
      const consumedDebt = summary.newDebt.authorized + summary.newDebt.unauthorized;

      // Weakening is judged against both protected surfaces: the
      // `.pocket-zipper` policy documents and the ESLint flat config's own rule
      // severities (lowering a governed rule to `"warn"` or `"off"` is a policy
      // change, not debt). The detection runs on every evaluation; it reports
      // nothing when nothing weakened.
      const headConfigRaw = readHeadContent(git, trees, options, headDir, PROTECTED_CONFIG);
      const headRegistryRaw = readHeadContent(git, trees, options, headDir, PROTECTED_REGISTRY);
      // Hoisted above the detector: the split hands the detector parsed records,
      // so the head read happens first. The throw lands before the first
      // `errors.push`, so a malformed head registry can never also be reported
      // as a policy change. The read is gated by the trigger too — an untracked
      // worktree registry a pre-commit never staged must not be pulled in and
      // validated into a false defect.
      const headRegistry = protectedTouched ? loadRegistry(headRegistryRaw) : null;
      const policyChange = detectPolicyChange({
        baselineConfig: baselinePolicyRaw,
        headConfig: headConfigRaw,
        baselineRegistry: registry,
        headRegistry,
        protectedTouched,
        baselineGoverned: governedBaseline,
        consumedDebt,
        baselineLevels: analysis.baselineLevels,
        headLevels: analysis.headLevels,
      });

      // The expiry policy: a newly written date past the **baseline** maximum
      // refuses. Its own rule, its own error code, and its own gate term — a
      // registry-only change that legalizes nothing is still a failure, so it
      // cannot be a term inside `detectPolicyChange` (which answers whether a
      // *weakening* was consumed by new debt) nor a `POLICY_CHANGE` variant. The
      // maximum comes from the baseline policy read above, never from the head
      // document sitting next to it: bumping `maxExpiry` in the same change
      // legalizes nothing.
      const refusals =
        headRegistry === null
          ? []
          : expiryPolicyRefusals({
              baseline: registry,
              head: headRegistry,
              now,
              maxExpiry: policy.exceptions.maxExpiry,
            });

      const gateFailure =
        summary.newDebt.unauthorized > 0 || policyChange.failure || refusals.length > 0;

      if (policyChange.weakening) {
        errors.push({
          code: "POLICY_CHANGE",
          message: policyChangeMessage(policyChange),
        });
      }

      // One error per refusing record, so CI can point at the offending entry
      // rather than at the file as a whole. The message carries the same four
      // facts `validate`'s `OVERLONG_EXCEPTION` diagnostic does — the date, the
      // record, the limit, and the ceiling — so the two surfaces read alike.
      for (const record of refusals) {
        errors.push({
          code: "EXPIRY_POLICY",
          message: expiryPolicyMessage(record, policy.exceptions.maxExpiry, now),
        });
      }

      const record = buildRecord({
        mode: options.mode,
        verdict: gateFailure ? "fail" : "pass",
        baseline: { ref: trees.baselineRef, tree: trees.baselineTree },
        proposedTree: trees.proposedTree,
        policy,
        governedRules: governedHead,
        head: coverage.head,
        removed: baseline,
        registry,
        cleanup,
        poolCounts: coverage.pools,
        exceptionStatuses: coverage.statuses,
        errors,
      });

      return {
        record,
        exitCode: gateFailure ? 1 : 0,
        report: "",
        suggestedExpiry: suggestedExpiry(now, policy.exceptions.defaultExpiry),
        maxExpiry: policy.exceptions.maxExpiry,
      };
    } finally {
      for (const dir of tmpDirs) git.cleanup(dir);
    }
  } catch (err) {
    if (err instanceof PocketZipperError) {
      // A defective registry read reports one error per defect, so the record
      // names every thing wrong with the file rather than only the first.
      errors.push(...errorRecords(err));
      return { record: failureRecord({ mode: options.mode, baseRef: options.baseRef, errors }), exitCode: 2, report: "", suggestedExpiry: undefined, maxExpiry: undefined };
    }
    errors.push({
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
    return { record: failureRecord({ mode: options.mode, baseRef: options.baseRef, errors }), exitCode: 2, report: "", suggestedExpiry: undefined, maxExpiry: undefined };
  }
}

/** The two shape clauses, appended to the routed/consumed sentences only when the registry contributed. */
const ADDITIVE_CLAUSE =
  ": a new exception record authorizes debt the baseline registry did not";
const EDIT_CLAUSE =
  ": an existing exception record's identity changed, so it now authorizes different debt";

/**
 * The `POLICY_CHANGE` error line: the shared weakening sentence, plus the
 * registry's shape when the registry itself contributed. The `eslint-config`
 * sentence never carries a clause — that surface has no registry shape to name.
 */
function policyChangeMessage(policyChange: PolicyChangeResult): string {
  const sentence = policyChange.failure
    ? "policy weakening consumed by new suppression debt in the same change"
    : policyChange.source === "eslint-config"
      ? "rule weakened in ESLint config: policy change recorded (review the config edit; not exceptable)"
      : "policy weakening detected (routed through protected-branch review)";
  const clause =
    policyChange.registry === "additive"
      ? ADDITIVE_CLAUSE
      : policyChange.registry === "edit"
        ? EDIT_CLAUSE
        : "";
  return `${sentence}${clause}`;
}

/**
 * One refusing record's error line. The facts are `validate`'s, deliberately:
 * the date that was written, which record wrote it, the maximum it runs past,
 * and the last date that maximum allows. It does not tell the reader to bump
 * `maxExpiry` — the two-step is a workflow the guides own, not a sentence to
 * repeat on every CI line.
 */
function expiryPolicyMessage(
  record: ExceptionRecord,
  maxExpiry: DurationLiteral,
  now: Date,
): string {
  return `newly written expires ${record.expires} for ${record.rule} in ${record.file} runs past the baseline ${maxExpiry} maximum (on or before ${expiryHorizon(now, maxExpiry)})`;
}

interface ResolvedTrees {
  baselineCommit: string;
  baselineRef: string;
  headCommit: string | null;
  baselineTree: string;
  proposedTree: string;
}

function resolveTrees(git: Git, options: EvaluateOptions): ResolvedTrees {
  if (options.mode === "pre-commit") {
    const hasHead = git.hasCommit("HEAD");
    const baselineCommit = hasHead ? git.revParse("HEAD") : EMPTY_TREE;
    const baselineTree = hasHead ? git.treeOf(baselineCommit) : EMPTY_TREE;
    let proposedTree = "index";
    const wt = git.run(["write-tree"], { allowFail: true });
    if (wt.status === 0 && wt.stdout.trim().length > 0) proposedTree = wt.stdout.trim();
    return {
      baselineCommit,
      baselineRef: hasHead ? "HEAD" : EMPTY_TREE,
      headCommit: null,
      baselineTree,
      proposedTree,
    };
  }

  const baseCommit = git.revParse(options.baseRef);
  const headCommit = git.revParse("HEAD");
  let baselineCommit: string;
  let baselineRef = options.baseRef;
  // Merge-result-first: the host supplies a two-parent merge commit whose
  // first parent is the current target tip (the supplied base). Anything else
  // — including a merge whose first parent is the head branch — falls back to
  // the computed merge-base rather than guessing.
  if (git.parentCount(headCommit) === 2 && git.revParse(`${headCommit}^1`) === baseCommit) {
    baselineCommit = baseCommit;
    baselineRef = "merge-result-first-parent";
  } else {
    const mb = git.mergeBase(baseCommit, headCommit);
    if (!mb) {
      throw gitError(
        "no merge-base between the target ref and HEAD (unrelated or rewritten history); provide a pinned base SHA from the host",
      );
    }
    baselineCommit = mb;
  }
  return {
    baselineCommit,
    baselineRef,
    headCommit,
    baselineTree: git.treeOf(baselineCommit),
    proposedTree: git.treeOf(headCommit),
  };
}

/**
 * The directory ESLint and the tombstone line-index read the proposed-change
 * tree from. Pre-commit uses the staged index tree; bare checkouts have no work
 * tree, so the head commit is materialized; otherwise the worktree is used.
 */
function resolveHeadDir(git: Git, options: EvaluateOptions, trees: ResolvedTrees): string {
  if (options.mode === "pre-commit" && trees.proposedTree !== "index") {
    return git.materialize(trees.proposedTree);
  }
  if (git.isBare()) {
    return git.materialize(trees.headCommit ?? trees.baselineCommit);
  }
  return git.root;
}

function assertGitPosture(git: Git, mode: Mode): void {
  if (git.promisorRemotes().length > 0) {
    throw gitError(
      "partial (promisor) clone detected; Pocket Zipper requires a full clone",
    );
  }
  if (git.isShallow()) {
    if (!git.tryUnshallow()) {
      throw gitError(
        "shallow repository and could not unshallow (offline?); provide a full clone or pinned base SHA",
      );
    }
  }
  if (git.isBare() && mode === "pre-commit") {
    throw gitError("pre-commit mode requires a work tree");
  }
}

interface AnalyzeInput {
  git: Git;
  options: EvaluateOptions;
  trees: ResolvedTrees;
  baselineDir: string;
  headDir: string;
  baselineSession: EslintSession;
  headSession: EslintSession;
  changeMap: ReturnType<Git["changeMap"]>;
}

interface Analysis {
  baselineSuppressions: LogicalSuppression[];
  headSuppressions: LogicalSuppression[];
  applicableBaseline: string[];
  applicableHead: string[];
  baselineLevels: ConfigSeverityLevel[];
  headLevels: ConfigSeverityLevel[];
  lineDiffs: Map<string, LineDiff>;
  baselineIndex: Set<string>;
  headIndex: Set<string>;
}

async function analyzeTrees(input: AnalyzeInput): Promise<Analysis> {
  const {
    git,
    options,
    trees,
    baselineDir,
    headDir,
    baselineSession,
    headSession,
    changeMap,
  } = input;

  const baselineSuppressions: LogicalSuppression[] = [];
  const headSuppressions: LogicalSuppression[] = [];
  const applicableBaselineSet = new Set<string>();
  const applicableHeadSet = new Set<string>();
  const lineDiffs = new Map<string, LineDiff>();

  for (const [newPath, statusRaw] of changeMap.files) {
    const status = statusRaw[0];
    if (changeMap.binary.has(newPath)) continue;
    if (isSkippedPath(newPath)) continue;
    const oldPath = changeMap.renames.get(newPath) ?? newPath;

    const baseContent = status === "A" ? null : git.fileAt(trees.baselineCommit, oldPath);
    const headContent =
      status === "D" ? null : readHeadContent(git, trees, options, headDir, newPath);

    // Line movement is judged on identity-canonicalized text (whitespace- and
    // justification-insensitive), so re-indentation and justification edits
    // never read as a fresh comment or a dead twin.
    if (baseContent !== null && headContent !== null) {
      lineDiffs.set(
        newPath,
        diffLineIndices(baseContent.split(/\r?\n/), headContent.split(/\r?\n/), (a, b) =>
          canonicalMovementLine(a) === canonicalMovementLine(b),
        ),
      );
    }

    if (baseContent !== null) {
      await recognizeSide({
        session: baselineSession,
        treeDir: baselineDir,
        relFile: oldPath,
        content: baseContent,
        suppressions: baselineSuppressions,
        applicable: applicableBaselineSet,
      });
    }
    if (headContent !== null) {
      await recognizeSide({
        session: headSession,
        treeDir: headDir,
        relFile: newPath,
        content: headContent,
        suppressions: headSuppressions,
        applicable: applicableHeadSet,
      });
    }
  }

  const baseOffs = await recognizeConfigOffs(baselineDir);
  const headOffs = await recognizeConfigOffs(headDir);
  baselineSuppressions.push(...baseOffs.suppressions);
  headSuppressions.push(...headOffs.suppressions);
  for (const s of baseOffs.suppressions) applicableBaselineSet.add(s.rule);
  for (const s of headOffs.suppressions) applicableHeadSet.add(s.rule);

  const baselineLevels = await configSeverityLevels(baselineDir);
  const headLevels = await configSeverityLevels(headDir);

  return {
    baselineSuppressions,
    headSuppressions,
    applicableBaseline: [...applicableBaselineSet],
    applicableHead: [...applicableHeadSet],
    baselineLevels,
    headLevels,
    lineDiffs,
    baselineIndex: buildLineIndex(baselineDir),
    headIndex: buildLineIndex(headDir),
  };
}

interface RecognizeSideInput {
  session: EslintSession;
  treeDir: string;
  relFile: string;
  content: string;
  suppressions: LogicalSuppression[];
  applicable: Set<string>;
}

async function recognizeSide(input: RecognizeSideInput): Promise<void> {
  const { session, treeDir, relFile, content, suppressions, applicable } = input;
  const { suppressions: found, applicable: fileApplicable } = await recognizeFile({
    session,
    treeDir,
    relFile,
    content,
  });
  for (const rule of fileApplicable) applicable.add(rule);
  suppressions.push(...found);
}

function readHeadContent(
  git: Git,
  trees: ResolvedTrees,
  options: EvaluateOptions,
  headDir: string,
  path: string,
): string | null {
  if (options.mode === "pre-commit") {
    const staged = git.stagedFile(path);
    if (staged !== null) return staged;
    return readTreeFile(headDir, path);
  }
  return git.fileAt(trees.headCommit!, path);
}

function readTreeFile(dir: string, path: string): string | null {
  try {
    return readFileSync(join(dir, path), "utf8");
  } catch {
    return null;
  }
}

function isSkippedPath(path: string): boolean {
  return SKIP_PREFIXES.some((p) => path.startsWith(p));
}

function buildLineIndex(dir: string): Set<string> {
  const index = new Set<string>();
  walk(dir, dir, index);
  return index;
}

function walk(root: string, dir: string, index: Set<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(root, full, index);
    } else if (st.isFile() && st.size < 2 * 1024 * 1024) {
      const rel = relative(root, full);
      if (isSkippedPath(rel)) continue;
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue;
      for (const line of content.split(/\r?\n/)) {
        const norm = canonicalCodeLine(line);
        if (norm.length > 0) index.add(norm);
      }
    }
  }
}

export type { SuppressionType, ErrorCode };
