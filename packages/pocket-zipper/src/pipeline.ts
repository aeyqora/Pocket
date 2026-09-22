import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Git, EMPTY_TREE } from "./git.js";
import { EslintSession } from "./eslint.js";
import {
  configPluginRuleNames,
  configSeverityLevels,
  recognizeConfigOffs,
  recognizeDirectives,
  applicableRules,
  type ConfigSeverityLevel,
} from "./recognize.js";
import { computeGovernedSet, parsePolicy } from "./policy.js";
import { coverExceptions, parseRegistry } from "./registry.js";
import { detectPolicyChange } from "./policy-change.js";
import { buildRecord, excludedRecord, failureRecord, summarize } from "./record.js";
import {
  canonicalCodeLine,
  canonicalMovementLine,
  diffLineIndices,
  type LineDiff,
} from "./identity.js";
import { reconcile } from "./reconcile.js";
import { PocketZipperError, eslintError, gitError } from "./errors.js";
import type {
  ErrorCode,
  EvaluationRecord,
  LogicalSuppression,
  Mode,
  RecordError,
  SuppressionType,
} from "./types.js";

export { TOOL_NAME, TOOL_VERSION, SCHEMA_VERSION } from "./record.js";

const PROTECTED_CONFIG = ".pocket-zipper/config.yml";
const PROTECTED_REGISTRY = ".pocket-zipper/exceptions.yml";
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
      const registry = parseRegistry(baselineRegistryRaw);

      const changeMap =
        options.mode === "pre-commit"
          ? git.stagedChangeMap()
          : git.changeMap(trees.baselineCommit, trees.headCommit!);

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
      const cleanup = {
        expired: coverage.counts.expired,
        dangling: coverage.counts.dangling,
        spent: coverage.counts.spent,
      };

      const summary = summarize(coverage.head, baseline.length);
      const consumedDebt = summary.newDebt.authorized + summary.newDebt.unauthorized;

      // Weakening is judged against both protected surfaces: the
      // `.pocket-zipper` policy documents and the ESLint flat config's own rule
      // severities (lowering a governed rule to `"warn"` or `"off"` is a policy
      // change, not debt). The detection runs on every evaluation; it reports
      // nothing when nothing weakened.
      const policyChange = detectPolicyChange({
        baselineConfig: baselinePolicyRaw,
        headConfig: readHeadContent(git, trees, options, headDir, PROTECTED_CONFIG),
        baselineRegistry: git.fileAt(trees.baselineCommit, PROTECTED_REGISTRY),
        headRegistry: readHeadContent(git, trees, options, headDir, PROTECTED_REGISTRY),
        baselineGoverned: governedBaseline,
        consumedDebt,
        baselineLevels: analysis.baselineLevels,
        headLevels: analysis.headLevels,
      });

      const gateFailure = summary.newDebt.unauthorized > 0 || policyChange.failure;

      if (policyChange.weakening) {
        errors.push({
          code: "POLICY_CHANGE",
          message: policyChange.failure
            ? "policy weakening consumed by new suppression debt in the same change"
            : policyChange.source === "eslint-config"
              ? "rule weakened in ESLint config: policy change recorded (review the config edit; not exceptable)"
              : "policy weakening detected (routed through protected-branch review)",
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
        exceptionStatuses: coverage.statuses,
        errors,
      });

      return {
        record,
        exitCode: gateFailure ? 1 : 0,
        report: "",
      };
    } finally {
      for (const dir of tmpDirs) git.cleanup(dir);
    }
  } catch (err) {
    if (err instanceof PocketZipperError) {
      errors.push({ code: err.code, message: err.message, detail: err.detail });
      return { record: failureRecord({ mode: options.mode, baseRef: options.baseRef, errors }), exitCode: 2, report: "" };
    }
    errors.push({
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
    return { record: failureRecord({ mode: options.mode, baseRef: options.baseRef, errors }), exitCode: 2, report: "" };
  }
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
  const filePath = join(treeDir, relFile);
  const { used, unused } = await session.lint(content, filePath);
  const cfg = await session.effectiveConfig(filePath);
  const fileApplicable = new Set(applicableRules(cfg));
  for (const rule of fileApplicable) applicable.add(rule);
  const comments = session.comments(content, filePath, cfg.languageOptions);
  const found = recognizeDirectives({ file: relFile, code: content, cfg, comments });
  // Fail closed if ESLint acknowledged a suppression we did not inventory as a
  // logical suppression: a "pass" must never mean "we didn't look".
  const inventoriedRules = new Set(found.map((s) => s.rule));
  const assertInventoried = (rule: string, shape: string): void => {
    if (fileApplicable.has(rule) && !inventoriedRules.has(rule)) {
      throw eslintError(
        `recognition missed a ${shape} logical suppression for rule '${rule}' in ${relFile}`,
      );
    }
  };
  for (const message of used) {
    const rule = message.ruleId;
    if (!rule) continue;
    const viaDirective = (message.suppressions ?? []).some((s) => s.kind === "directive");
    if (viaDirective) assertInventoried(rule, "used");
  }
  for (const directive of unused) {
    if (directive.isEnable) continue;
    for (const rule of directive.ruleNames) assertInventoried(rule, "unused");
  }
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
