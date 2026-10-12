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
import {
  computeGovernedSet,
  expiryHorizon,
  parsePolicy,
  suggestedExpiry,
  viewPolicy,
} from "./policy.js";
import {
  coverExceptions,
  expiryPolicyMessage,
  expiryPolicyRefusals,
  overlongRecords,
} from "./registry.js";
import { unusedExceptions } from "./cleanup.js";
import {
  errorRecords,
  loadRegistry,
  loadRegistryEntries,
  RegistryDefectError,
} from "./validate.js";
import { PROTECTED_CONFIG, PROTECTED_REGISTRY } from "./protected-paths.js";

import {
  detectPolicyChange,
  severityFloorViolations,
  type PolicyChangeResult,
  type SeverityFloorViolation,
} from "./policy-change.js";
import {
  buildRecord,
  consumedDebtCount,
  excludedRecord,
  failureRecord,
  summarize,
} from "./record.js";
import {
  canonicalCodeLine,
  canonicalMovementLine,
  diffLineIndices,
  type LineDiff,
} from "./continuity.js";
import { reconcile } from "./reconcile.js";
import { governedPathSet, isGovernedPath, isGovernedSuppression } from "./governed-path.js";
import { PocketZipperError, gitError } from "./errors.js";
import type {
  DurationLiteral,
  ErrorCode,
  EvaluationRecord,
  ExceptionRecord,
  LogicalSuppression,
  Mode,
  Policy,
  RecordError,
  ReconciledSuppression,
  SuppressionType,
  UnusedException,
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
  /**
   * Every unused record, with the delete-ready pointer that finds it. Mirrors
   * `record.unused` rather than replacing it: the report needs them without
   * unwrapping the record, and both are the same derivation, so they cannot
   * disagree.
   */
  unused: UnusedException[];
  /**
   * Non-failing config warnings the policy parse raised — a wildcard path
   * pattern matching nothing, for example. Not gate terms: they ride the
   * report's stdout, never the record's `errors`.
   */
  warnings: string[];
}

export async function evaluate(options: EvaluateOptions): Promise<EvaluateResult> {
  const now = options.now ?? new Date();
  const errors: RecordError[] = [];
  const warnings: string[] = [];

  try {
    const git = await Git.discover(options.cwd);
    assertGitPosture(git, options.mode);

    const trees = resolveTrees(git, options);

    // The effective policy is the baseline's and shapes whether anything is
    // evaluated at all. Read it before touching ESLint so `enabled: false`
    // genuinely evaluates nothing. The path inventory rides along from the
    // start: the path pair's no-match check is filesystem-local, so it runs
    // even while the gate is disabled, and a typo in a dormant policy fails
    // closed rather than lying silent until the flip.
    const pathInventory = git.trackedPaths(trees.baselineCommit);
    const baselinePolicyRaw = git.fileAt(trees.baselineCommit, PROTECTED_CONFIG);
    const initialPolicy = parsePolicy(baselinePolicyRaw, new Set(), pathInventory, warnings);
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
        unused: [],
        warnings,
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
      const policy = parsePolicy(baselinePolicyRaw, knownRules, pathInventory, warnings);
      // The change map must exist before the baseline registry read: a repair is
      // the one case where a defective baseline registry may be replaced by the
      // head-side document. The policy above is already the fully known-rule
      // parse, so a defective baseline config still aborts before this carve-out.
      const changeMap =
        options.mode === "pre-commit"
          ? git.stagedChangeMap()
          : git.changeMap(trees.baselineCommit, trees.headCommit!);
      const protectedTouched =
        changeMap.files.has(PROTECTED_CONFIG) || changeMap.files.has(PROTECTED_REGISTRY);
      const headConfigRaw = readHeadContent(git, trees, options, headDir, PROTECTED_CONFIG);
      const headRegistryRaw = readHeadContent(git, trees, options, headDir, PROTECTED_REGISTRY);
      // Read the head registry before the baseline so a repair carrying a still-
      // defective head fails with the head's defects. The baseline may decline
      // to abort only when the change carries the registry and this read succeeds.
      const headRegistry = protectedTouched ? loadRegistry(headRegistryRaw) : null;

      let baselineRegistryForDelta: readonly ExceptionRecord[] | null;
      let baselineDefectErrors: RecordError[] = [];
      // One read, two shapes: the records the gate matches on, and the entries
      // carrying their positions and text for the cleanup pointers. Reading the
      // file twice would be a second chance to disagree with itself.
      let registryEntries: ReturnType<typeof loadRegistryEntries>;
      try {
        registryEntries = loadRegistryEntries(baselineRegistryRaw);
        baselineRegistryForDelta = registryEntries.map((entry) => entry.record);
      } catch (err) {
        if (
          !(err instanceof RegistryDefectError) ||
          !changeMap.files.has(PROTECTED_REGISTRY) ||
          headRegistry === null
        ) {
          throw err;
        }

        // A repaired registry is evaluated with empty baseline coverage. This
        // keeps the one-merge lag intact: repaired records cannot authorize debt
        // in their own change. The repair is still a protected additive policy
        // change, so the most it can smuggle is a debt-free registry repair.
        registryEntries = [];
        baselineRegistryForDelta = null;
        baselineDefectErrors = errorRecords(err).map((error) => ({
          ...error,
          code: "BASELINE_DEFECT" as const,
        }));
      }
      const registry = registryEntries.map((entry) => entry.record);

      const analysis = await analyzeTrees({
        baselineDir,
        headDir,
        baselineSession,
        headSession,
        changeMap,
        baselineContent: (path) => git.fileAt(trees.baselineCommit, path),
        headContent: (path) => readHeadContent(git, trees, options, headDir, path),
        governedPath: (path) => isGovernedPath(policy, path),
      });

      // The governed path set, computed once: both the reconciliation's path
      // filter and the policy track's reach judgment intersect against it.
      const governedPathSetValue = governedPathSet(policy, pathInventory);

      const { head, removed: baseline, governedHead, governedBaseline } = reconcileGoverned({
        policy,
        analysis,
        governedPaths: governedPathSetValue,
      });
      // Severity weakening has a different baseline set from reconciliation:
      // config declarations govern a rule even when no changed file matches
      // their scope. Keep `governedBaseline` changed-files-only so this set
      // cannot pull unrelated suppressions into continuity reconciliation.
      const baselineSeverityGoverned = computeGovernedSet(
        policy,
        analysis.baselineLevels.map((level) => level.rule),
      );

      // The gate's failure term, before anything is authorized. Coverage cannot
      // move it, and that is what lets the order below run shape → opt-in →
      // coverage: the verdict decides which records may join coverage, so a
      // verdict derived from coverage would be waiting for an answer it is
      // supposed to give.
      const consumedDebt = consumedDebtCount(head);

      // Weakening is judged against both protected surfaces: the
      // `.pocket-zipper` policy documents and the ESLint flat config's own rule
      // severities (lowering a governed rule to `"warn"` or `"off"` is a policy
      // change, not debt). The detection runs on every evaluation; it reports
      // nothing when nothing weakened.
      const policyChange = detectPolicyChange({
        baselineConfig: baselinePolicyRaw,
        headConfig: headConfigRaw,
        baselineRegistry: baselineRegistryForDelta,
        headRegistry,
        protectedTouched,
        baselineRegistryDefect: baselineDefectErrors.length > 0,
        baselineGoverned: governedBaseline,
        baselineSeverityGoverned,
        consumedDebt,
        baselinePolicy: policy,
        baselineLevels: analysis.baselineLevels,
        headLevels: analysis.headLevels,
        governedPaths: governedPathSetValue,
      });
      // Floors are baseline policy, but unlike the protected-file half of the
      // policy delta they always inspect both ESLint config trees. This keeps a
      // floor active when the change touches only eslint.config.* or source.
      const floorViolations = severityFloorViolations({
        minSeverities: policy.minSeverities,
        baselineLevels: analysis.baselineLevels,
        headLevels: analysis.headLevels,
        governedPaths: governedPathSetValue,
      });
      const stagedFloors =
        options.mode === "pre-commit" ? viewPolicy(headConfigRaw).minSeverities : null;

      // One suppression, read in one place, by both of the terms that depend on
      // it. When the host's path-scoped approval stands in for the second PR, the
      // delta is a same-change exception: the sanctioned additions join coverage
      // below, and neither the gate nor the `POLICY_CHANGE` signal is raised for
      // it. `combined` is false on a delta that weakened nothing, so the union
      // above needs no second term, while the signal below does — there is nothing
      // to signal unless something weakened. `failure` is derived from the same
      // field in the detector, so no term here can disagree with it.
      const excepted = policyChange.combined;

      // The evaluation's registry: the baseline's, plus the additions the
      // same-change exception sanctions. A record rides the one change it
      // authorizes, so the change's own record is what the change is judged
      // against; the union is also what the record is built from, which is the
      // honest reading of "the evaluation's coverage" — the record this run
      // publishes names the record this run credited. The additions come from
      // the detector with the verdict, off one pass over the two registries,
      // so the union and the verdict cannot disagree.
      const records = excepted ? [...registry, ...policyChange.sanctioned] : registry;
      const coverage = coverExceptions({ head, records, now });
      // Overlong is hygiene over the *baseline* registry, like every other
      // cleanup counter: a landed date past the maximum still authorizes and is
      // counted, and a change that newly writes one is refused below. It stays
      // baseline-only even when a record rides, because a newly written
      // far-future date is already a refusal and counting it as hygiene too is
      // the same failure reported twice. Derived here, not in `validate`, so the
      // report reads the evaluation's own statuses (expired wins) — while
      // `pocket-zipper validate` lints the working tree and so reads the *head*
      // policy's maximum. That divergence is correct: the two commands answer
      // different questions.
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

      // The addresses behind those counts: every unused baseline record, with
      // the registry line range and its own text that make deletion
      // find-in-one-glance, where its suppression lives now, and whether this
      // change is what orphaned it.
      //
      // Derived from the baseline registry rather than the evaluation's union,
      // so a pointer never names a record the file does not carry; a record
      // riding the change under combined landing has no address in the baseline
      // to point at, and is reported the next run, once the file carries it.
      const unused = unusedExceptions({
        entries: registryEntries,
        statuses: coverage.statuses,
        live: coverage.head,
        removed: baseline,
      });

      const summary = summarize(coverage.head, baseline.length);

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
        summary.newDebt.unauthorized > 0 ||
        policyChange.failure ||
        refusals.length > 0 ||
        floorViolations.length > 0;

      if (policyChange.weakening && !excepted) {
        errors.push({
          code: "POLICY_CHANGE",
          message: policyChangeMessage(policyChange),
        });
      }
      errors.push(...baselineDefectErrors);

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
      for (const violation of floorViolations) {
        errors.push({
          code: "SEVERITY_FLOOR",
          message: severityFloorMessage(violation, options.mode, stagedFloors),
          detail: violation,
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
        registry: records,
        cleanup,
        poolCounts: coverage.pools,
        exceptionStatuses: coverage.statuses,
        unused,
        errors,
      });

      return {
        record,
        exitCode: gateFailure ? 1 : 0,
        report: "",
        suggestedExpiry: suggestedExpiry(now, policy.exceptions.defaultExpiry),
        maxExpiry: policy.exceptions.maxExpiry,
        unused,
        warnings,
      };
    } finally {
      for (const dir of tmpDirs) git.cleanup(dir);
    }
  } catch (err) {
    if (err instanceof PocketZipperError) {
      // A defective registry read reports one error per defect, so the record
      // names every thing wrong with the file rather than only the first.
      errors.push(...errorRecords(err));
      return { record: failureRecord({ mode: options.mode, baseRef: options.baseRef, errors }), exitCode: 2, report: "", suggestedExpiry: undefined, maxExpiry: undefined, unused: [], warnings };
    }
    errors.push({
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
    return { record: failureRecord({ mode: options.mode, baseRef: options.baseRef, errors }), exitCode: 2, report: "", suggestedExpiry: undefined, maxExpiry: undefined, unused: [], warnings };
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
  if (policyChange.baselineRepair) {
    return policyChange.failure
      ? "poisoned baseline registry repair consumed by new suppression debt in the same change"
      : "poisoned baseline registry repaired (routed through protected-branch review)";
  }
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

function severityFloorMessage(
  violation: SeverityFloorViolation,
  mode: Mode,
  stagedFloors: Record<string, "off" | "warn" | "error"> | null,
): string {
  const base = `rule '${violation.rule}' is below severity floor '${violation.floor}': head is '${violation.head}', baseline is '${violation.baseline}'`;
  if (mode !== "pre-commit") return base;
  const staged = stagedFloors?.[violation.rule] ?? "none";
  return `${base}; staged policy floor is '${staged}' and takes effect from the next commit`;
}

/** The governed, reconciled half of one analysis: what every evaluation and every authoring session reads off it. */
export interface GovernedReconciliation {
  /** The governed rules of the head side — the evaluation record's `governedRules`. */
  governedHead: string[];
  /** The governed rules of the baseline side — the policy-change detector's allowlist. */
  governedBaseline: string[];
  /** The reconciled proposed-change side, governed rules only. */
  head: ReconciledSuppression[];
  /** The baseline suppressions the change deleted. */
  removed: LogicalSuppression[];
}

/**
 * The post-analysis half the evaluation and the authoring surface share:
 * narrow both sides to the governed set, then reconcile continuity. The two
 * disagree only about what they cover the reconciled debt against — the
 * evaluation's baseline registry (plus its same-change additions), the
 * wizard's working-tree registry — so coverage stays with each caller.
 */
export function reconcileGoverned(input: {
  policy: Policy;
  analysis: Analysis;
  governedPaths: ReadonlySet<string>;
}): GovernedReconciliation {
  const { policy, analysis, governedPaths } = input;
  const governedHead = computeGovernedSet(policy, analysis.applicableHead);
  const governedBaseline = computeGovernedSet(policy, analysis.applicableBaseline);
  const { head, removed } = reconcile({
    headSuppressions: analysis.headSuppressions.filter(
      (s) => governedHead.includes(s.rule) && isGovernedSuppression(policy, s, governedPaths),
    ),
    baselineSuppressions: analysis.baselineSuppressions.filter(
      (s) => governedBaseline.includes(s.rule) && isGovernedSuppression(policy, s, governedPaths),
    ),
    lineDiffs: analysis.lineDiffs,
    baselineIndex: analysis.baselineIndex,
    headIndex: analysis.headIndex,
    renames: analysis.renames,
  });
  return { governedHead, governedBaseline, head, removed };
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
  baselineDir: string;
  headDir: string;
  baselineSession: EslintSession;
  headSession: EslintSession;
  changeMap: ReturnType<Git["changeMap"]>;
  /**
   * Reads the baseline side of one changed path — the head commit's blob for
   * `check` and `pre-commit`, the wizard's HEAD for the working tree it reads
   * against. Returns null where the baseline does not carry the path.
   */
  baselineContent: (path: string) => string | null;
  /**
   * Reads the proposed-change side of one changed path — the one thing the
   * three callers of this engine legitimately disagree about: `check` reads
   * the head commit's blob, `pre-commit` the staged blob with a worktree
   * fallback, the wizard the working tree itself. Returns null where the side
   * does not carry the path.
   */
  headContent: (path: string) => string | null;
  /**
   * Whether a repository-relative path is governed, on the path axis. Drives
   * the whole-tree tomb walk's skip of ungoverned paths, so the content index a
   * tomb judgment reads never mistakes an ungoverned file for a dead twin's or
   * a newborn statement's home.
   */
  governedPath: (path: string) => boolean;
}

export interface Analysis {
  baselineSuppressions: LogicalSuppression[];
  headSuppressions: LogicalSuppression[];
  applicableBaseline: string[];
  applicableHead: string[];
  baselineLevels: ConfigSeverityLevel[];
  headLevels: ConfigSeverityLevel[];
  lineDiffs: Map<string, LineDiff>;
  /** post-image path -> pre-image path for git-recognized renames */
  renames: Map<string, string>;
  baselineIndex: Set<string>;
  headIndex: Set<string>;
}

/**
 * The one recognition engine every inventory runs through: baseline and head
 * ESLint sessions over the changed paths, the config-level suppressions, the
 * severity bands, and the line indexes the tomb judgment reads. Exported for
 * the wizard, which recomputes the working tree's debt with the same engine
 * the gate reads with — the only injected part is how each side of the diff is
 * read.
 */
export async function analyzeTrees(input: AnalyzeInput): Promise<Analysis> {
  const {
    baselineDir,
    headDir,
    baselineSession,
    headSession,
    changeMap,
    baselineContent,
    headContent,
    governedPath,
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

    const baseContent = status === "A" ? null : baselineContent(oldPath);
    const headContent = status === "D" ? null : input.headContent(newPath);

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
    renames: changeMap.renames,
    baselineIndex: buildLineIndex(baselineDir, governedPath),
    headIndex: buildLineIndex(headDir, governedPath),
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

function buildLineIndex(dir: string, governedPath: (path: string) => boolean): Set<string> {
  const index = new Set<string>();
  walk(dir, dir, index, governedPath);
  return index;
}

function walk(
  root: string,
  dir: string,
  index: Set<string>,
  governedPath: (path: string) => boolean,
): void {
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
      walk(root, full, index, governedPath);
    } else if (st.isFile() && st.size < 2 * 1024 * 1024) {
      const rel = relative(root, full);
      if (isSkippedPath(rel)) continue;
      // The tomb walk skips ungoverned paths: an ungoverned file is never the
      // home of a dead twin or a newborn statement, so its lines must not sit
      // in the index a tomb judgment reads.
      if (!governedPath(rel)) continue;
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
