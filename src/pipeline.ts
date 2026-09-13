import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { Git, EMPTY_TREE } from "./git.js";
import { EslintSession } from "./eslint.js";
import { recognizeConfigOffs, recognizeDirectives, applicableRules } from "./recognize.js";
import { computeGovernedSet, parsePolicy } from "./policy.js";
import { isExpired, parseRegistry } from "./registry.js";
import { driftDisposition, pairPools } from "./identity.js";
import { PocketLockError, configError, gitError } from "./errors.js";
import type {
  Disposition,
  ErrorCode,
  EvaluationRecord,
  EvaluationSummary,
  ExceptionRecord,
  ExceptionRef,
  InventoryEntry,
  LogicalSuppression,
  Mode,
  Policy,
  RecordError,
  RecordExceptionEntry,
  SuppressionType,
  Verdict,
} from "./types.js";

export const TOOL_NAME = "pocket-lock";
export const TOOL_VERSION = "0.1.0";
export const SCHEMA_VERSION = 1 as const;

const PROTECTED_CONFIG = ".pocket-lock/config.yml";
const PROTECTED_REGISTRY = ".pocket-lock/exceptions.yml";
const SKIP_PREFIXES = [".git/", "node_modules/", ".pocket-lock/"];

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

interface HeadSuppression extends LogicalSuppression {
  disposition: Disposition;
  baselineLine: number | null;
  matched?: LogicalSuppression;
  exception: ExceptionRef | null;
}

interface BaselineSuppression extends LogicalSuppression {
  removed: boolean;
}

export async function evaluate(options: EvaluateOptions): Promise<EvaluateResult> {
  const now = options.now ?? new Date();
  const git = await Git.discover(options.cwd);
  const errors: RecordError[] = [];

  try {
    assertGitPosture(git, options.mode);

    const trees = resolveTrees(git, options);

    // The effective policy is the baseline's and shapes whether anything is
    // evaluated at all. Read it before touching ESLint so `enabled: false`
    // genuinely evaluates nothing.
    const baselinePolicyRaw = git.fileAt(trees.baselineCommit, PROTECTED_CONFIG);
    const initialPolicy = parsePolicy(baselinePolicyRaw, new Set());
    if (!initialPolicy.enabled) {
      return excludedResult(options, trees, initialPolicy);
    }

    const baselineDir = git.materialize(trees.baselineCommit);
    const headDir =
      options.mode === "pre-commit" && trees.proposedTree !== "index"
        ? git.materialize(trees.proposedTree)
        : git.root;
    const tmpDirs = [baselineDir, ...(headDir === git.root ? [] : [headDir])];

    try {
      const baselineSession = await EslintSession.create(baselineDir);
      const headSession = await EslintSession.create(headDir);
      const knownRules = headSession.coreRuleNames();

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

      const { head, baseline } = reconcileSuppressions({
        headSuppressions,
        baselineSuppressions,
        lineDiffs: analysis.lineDiffs,
        baselineIndex: analysis.baselineIndex,
        headIndex: analysis.headIndex,
      });

      const { expired, dangling, spent } = applyExceptions({
        head,
        registry,
        now,
      });

      const policyChange = detectPolicyChange({
        git,
        options,
        trees,
        headDir,
        changeMap,
        consumedDebt: head.filter(
          (h) => h.disposition === "new" || h.disposition === "materially-changed",
        ).length,
      });

      const gateFailure =
        head.some(
          (h) =>
            (h.disposition === "new" || h.disposition === "materially-changed") &&
            h.exception === null,
        ) || policyChange.failure;

      if (policyChange.weakening) {
        errors.push({
          code: "POLICY_CHANGE",
          message: policyChange.failure
            ? "policy weakening consumed by new suppression debt in the same change"
            : "policy weakening detected (routed through protected-branch review)",
        });
      }

      const record = buildRecord({
        options,
        trees,
        policy,
        governedRules: governedHead,
        head,
        baseline,
        registry,
        expired,
        dangling,
        spent,
        errors,
        verdict: gateFailure ? "fail" : "pass",
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
    if (err instanceof PocketLockError) {
      errors.push({ code: err.code, message: err.message, detail: err.detail });
      const record: EvaluationRecord = {
        schemaVersion: SCHEMA_VERSION,
        tool: { name: TOOL_NAME, version: TOOL_VERSION },
        mode: options.mode,
        verdict: "fail",
        baseline: { ref: options.baseRef, tree: "" },
        proposedChange: { ref: options.mode === "check" ? "HEAD" : "index", tree: "" },
        summary: emptySummary(),
        inventory: [],
        exceptions: [],
        errors,
      };
      return { record, exitCode: 2, report: "" };
    }
    errors.push({
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
    return {
      record: {
        schemaVersion: SCHEMA_VERSION,
        tool: { name: TOOL_NAME, version: TOOL_VERSION },
        mode: options.mode,
        verdict: "fail",
        baseline: { ref: options.baseRef, tree: "" },
        proposedChange: { ref: options.mode === "check" ? "HEAD" : "index", tree: "" },
        summary: emptySummary(),
        inventory: [],
        exceptions: [],
        errors,
      },
      exitCode: 2,
      report: "",
    };
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
  if (git.parentCount(headCommit) >= 2) {
    baselineCommit = git.revParse(`${headCommit}^1`);
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

function assertGitPosture(git: Git, mode: Mode): void {
  if (git.promisorRemotes().length > 0) {
    throw gitError(
      "partial (promisor) clone detected; Pocket Lock requires a full clone",
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
  lineDiffs: Map<string, { addedHead: Set<number>; removedBase: Set<number> }>;
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
  const lineDiffs =
    options.mode === "pre-commit"
      ? git.stagedUnifiedHunks()
      : git.unifiedChangeHunks(trees.baselineCommit, trees.headCommit!);

  for (const [newPath, statusRaw] of changeMap.files) {
    const status = statusRaw[0];
    if (changeMap.binary.has(newPath)) continue;
    if (isSkippedPath(newPath)) continue;
    const oldPath = changeMap.renames.get(newPath) ?? newPath;

    const baseContent = status === "A" ? null : git.fileAt(trees.baselineCommit, oldPath);
    const headContent =
      status === "D" ? null : readHeadContent(git, trees, options, headDir, newPath);

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

  return {
    baselineSuppressions,
    headSuppressions,
    applicableBaseline: [...applicableBaselineSet],
    applicableHead: [...applicableHeadSet],
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
  await session.lint(content, filePath);
  const cfg = await session.effectiveConfig(filePath);
  for (const rule of applicableRules(cfg)) applicable.add(rule);
  const comments = session.comments(content, filePath, cfg.languageOptions);
  const found = recognizeDirectives({ file: relFile, code: content, cfg, comments });
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

function canonicalLine(line: string): string {
  let s = line.trim().replace(/\s+/g, " ");
  const m = /\s--\s+/.exec(s);
  if (m && /eslint-/.test(s.slice(0, m.index))) s = s.slice(0, m.index);
  return s;
}

interface ReconcileInput {
  headSuppressions: LogicalSuppression[];
  baselineSuppressions: LogicalSuppression[];
  lineDiffs: Map<string, { addedHead: Set<number>; removedBase: Set<number> }>;
  baselineIndex: Set<string>;
  headIndex: Set<string>;
}

interface ReconcileOutput {
  head: HeadSuppression[];
  baseline: BaselineSuppression[];
}

function reconcileSuppressions(input: ReconcileInput): ReconcileOutput {
  const { headSuppressions, baselineSuppressions, lineDiffs, baselineIndex, headIndex } =
    input;

  const groups = new Map<string, { head: LogicalSuppression[]; baseline: LogicalSuppression[] }>();
  // Continuity is by fingerprint (§8.2): form + normalized rule tokens. Pools
  // additionally separate by guarded rule and suppression type so multi-rule
  // directives expand independently.
  const keyOf = (s: LogicalSuppression) =>
    `${s.fingerprint}\u0000${s.rule}\u0000${s.suppressionType}`;
  for (const s of baselineSuppressions) {
    const k = keyOf(s);
    const g = groups.get(k) ?? { head: [], baseline: [] };
    g.baseline.push(s);
    groups.set(k, g);
  }
  for (const s of headSuppressions) {
    const k = keyOf(s);
    const g = groups.get(k) ?? { head: [], baseline: [] };
    g.head.push(s);
    groups.set(k, g);
  }

  const headOut: HeadSuppression[] = [];
  const baselineOut: BaselineSuppression[] = [];
  const matchedBaseline = new Set<LogicalSuppression>();

  for (const [, group] of groups) {
    const pairs = pairPools(group.head, group.baseline);
    const pairedHead = new Set<LogicalSuppression>();
    for (const p of pairs) {
      pairedHead.add(p.head);
      matchedBaseline.add(p.baseline);
      const drift = driftDisposition(p.head, p.baseline);
      let disposition: Disposition = drift;
      const tomb = isTomb(p.head, p.baseline, lineDiffs, baselineIndex, headIndex);
      if (tomb) disposition = "materially-changed";
      headOut.push({
        ...p.head,
        disposition,
        baselineLine: p.baseline.line,
        matched: p.baseline,
        exception: null,
      });
    }
    for (const h of group.head) {
      if (pairedHead.has(h)) continue;
      headOut.push({ ...h, disposition: "new", baselineLine: null, exception: null });
    }
    for (const b of group.baseline) {
      baselineOut.push({ ...b, removed: !matchedBaseline.has(b) });
    }
  }

  headOut.sort(compareSuppressions);
  const removed = baselineOut.filter((b) => b.removed);
  removed.sort(compareSuppressions);
  return { head: headOut, baseline: removed };
}

function isTomb(
  head: LogicalSuppression,
  baseline: LogicalSuppression,
  lineDiffs: Map<string, { addedHead: Set<number>; removedBase: Set<number> }>,
  baselineIndex: Set<string>,
  headIndex: Set<string>,
): boolean {
  if (head.guardKind !== "directive") return false;
  if (head.suppressionType !== "next-line" && head.suppressionType !== "line") return false;

  const diff = lineDiffs.get(head.file);
  const commentAdded = diff ? diff.addedHead.has(head.line) : false;
  if (!commentAdded) return false;

  const twinRemoved = diff ? diff.removedBase.has(baseline.line) : false;
  if (!twinRemoved) return false;

  const newStatement =
    head.guardedContent.length > 0 && !baselineIndex.has(head.guardedContent);
  const deadTwin =
    baseline.guardedContent.length > 0 && !headIndex.has(baseline.guardedContent);
  return newStatement && deadTwin;
}

function compareSuppressions(a: LogicalSuppression, b: LogicalSuppression): number {
  return a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule);
}

interface ApplyExceptionsInput {
  head: HeadSuppression[];
  registry: ExceptionRecord[];
  now: Date;
}

function applyExceptions(input: ApplyExceptionsInput): {
  expired: number;
  dangling: number;
  spent: number;
} {
  const { head, registry, now } = input;
  const usedRecords = new Set<ExceptionRecord>();
  let expired = 0;

  for (const h of head) {
    if (h.disposition !== "new" && h.disposition !== "materially-changed") continue;
    const record = registry.find(
      (r) =>
        r.fingerprint === h.fingerprint &&
        r.suppression_type === h.suppressionType &&
        r.rule === h.rule,
    );
    if (!record) continue;
    if (record.file !== h.file) {
      throw configError(
        `exception for ${h.rule} names file '${record.file}' but the suppression is at '${h.file}'`,
      );
    }
    if (isExpired(record.expires, now)) {
      expired++;
      usedRecords.add(record);
      continue;
    }
    h.exception = {
      fingerprint: record.fingerprint,
      suppressionType: record.suppression_type,
      rule: record.rule,
    };
    usedRecords.add(record);
  }

  let dangling = 0;
  let spent = 0;
  for (const record of registry) {
    if (usedRecords.has(record)) continue;
    const matchesExisting = head.some(
      (h) =>
        (h.disposition === "existing" || h.disposition === "moved-existing") &&
        h.fingerprint === record.fingerprint &&
        h.suppressionType === record.suppression_type &&
        h.rule === record.rule,
    );
    if (matchesExisting) spent++;
    else if (isExpired(record.expires, now)) expired++;
    else dangling++;
  }

  return { expired, dangling, spent };
}

interface PolicyChangeInput {
  git: Git;
  options: EvaluateOptions;
  trees: ResolvedTrees;
  headDir: string;
  changeMap: ReturnType<Git["changeMap"]>;
  consumedDebt: number;
}

interface PolicyChangeResult {
  weakening: boolean;
  failure: boolean;
}

function detectPolicyChange(input: PolicyChangeInput): PolicyChangeResult {
  const { git, options, trees, headDir, changeMap, consumedDebt } = input;
  const touchesProtected =
    changeMap.files.has(PROTECTED_CONFIG) || changeMap.files.has(PROTECTED_REGISTRY);
  if (!touchesProtected) return { weakening: false, failure: false };

  const baselineConfig = git.fileAt(trees.baselineCommit, PROTECTED_CONFIG);
  const headConfig = readHeadProtected(git, trees, options, headDir, PROTECTED_CONFIG);
  const baselineRegistry = git.fileAt(trees.baselineCommit, PROTECTED_REGISTRY);
  const headRegistry = readHeadProtected(git, trees, options, headDir, PROTECTED_REGISTRY);

  const weakening =
    configWeakened(baselineConfig, headConfig) ||
    registryBroadened(baselineRegistry, headRegistry);

  if (!weakening) return { weakening: false, failure: false };
  return { weakening: true, failure: consumedDebt > 0 };
}

function readHeadProtected(
  git: Git,
  trees: ResolvedTrees,
  options: EvaluateOptions,
  headDir: string,
  path: string,
): string | null {
  if (options.mode === "pre-commit") {
    return git.stagedFile(path) ?? readTreeFile(headDir, path);
  }
  return git.fileAt(trees.headCommit!, path);
}

function configWeakened(baselineRaw: string | null, headRaw: string | null): boolean {
  const parseLenient = (raw: string | null): { enabled: boolean; rules: string[] | null } => {
    if (raw === null || raw.trim() === "") return { enabled: true, rules: null };
    try {
      const doc = raw.includes(":")
        ? (parseYaml(raw) as Record<string, unknown>)
        : ({} as Record<string, unknown>);
      const enabled = typeof doc["enabled"] === "boolean" ? (doc["enabled"] as boolean) : true;
      const rulesRaw = doc["governedRules"];
      const rules = Array.isArray(rulesRaw)
        ? rulesRaw.filter((r): r is string => typeof r === "string")
        : null;
      return { enabled, rules };
    } catch {
      return { enabled: true, rules: null };
    }
  };
  const base = parseLenient(baselineRaw);
  const head = parseLenient(headRaw);
  if (base.enabled && !head.enabled) return true;
  if (base.rules === null && head.rules !== null) return true;
  if (base.rules !== null && head.rules !== null) {
    const headSet = new Set(head.rules);
    if (base.rules.some((r) => !headSet.has(r))) return true;
  }
  return false;
}

function registryBroadened(baselineRaw: string | null, headRaw: string | null): boolean {
  const triples = (raw: string | null): Set<string> => {
    if (raw === null || raw.trim() === "") return new Set();
    try {
      const records = parseRegistry(raw);
      return new Set(records.map((r) => `${r.fingerprint}\u0000${r.suppression_type}\u0000${r.rule}`));
    } catch {
      return new Set(["<malformed>"]);
    }
  };
  const base = triples(baselineRaw);
  const head = triples(headRaw);
  for (const t of head) if (!base.has(t)) return true;
  return false;
}

interface BuildRecordInput {
  options: EvaluateOptions;
  trees: ResolvedTrees;
  policy: Policy;
  governedRules: string[];
  head: HeadSuppression[];
  baseline: BaselineSuppression[];
  registry: ExceptionRecord[];
  expired: number;
  dangling: number;
  spent: number;
  errors: RecordError[];
  verdict: Verdict;
}

function buildRecord(input: BuildRecordInput): EvaluationRecord {
  const { options, trees, policy, governedRules, head, baseline, errors, verdict } = input;
  const summary: EvaluationSummary = {
    policy: { enabled: policy.enabled, allowlist: policy.governedRules },
    governedRules,
    dispositions: {
      existing: head.filter((h) => h.disposition === "existing").length,
      movedExisting: head.filter((h) => h.disposition === "moved-existing").length,
      removed: baseline.length,
      new: head.filter((h) => h.disposition === "new").length,
      materiallyChanged: head.filter((h) => h.disposition === "materially-changed").length,
    },
    newDebt: {
      authorized: head.filter(
        (h) =>
          (h.disposition === "new" || h.disposition === "materially-changed") &&
          h.exception !== null,
      ).length,
      unauthorized: head.filter(
        (h) =>
          (h.disposition === "new" || h.disposition === "materially-changed") &&
          h.exception === null,
      ).length,
    },
    cleanup: {
      danglingExceptions: input.dangling,
      spentExceptions: input.spent,
      expiredExceptions: input.expired,
    },
  };

  const inventory: InventoryEntry[] = [
    ...head.map((h) => ({
      fingerprint: h.fingerprint,
      rule: h.rule,
      suppressionType: h.suppressionType,
      guardKind: h.guardKind,
      disposition: h.disposition,
      file: h.file,
      lines: { baseline: h.baselineLine, head: h.line },
      exception: h.exception,
    })),
    ...baseline.map((b) => ({
      fingerprint: b.fingerprint,
      rule: b.rule,
      suppressionType: b.suppressionType,
      guardKind: b.guardKind,
      disposition: "removed" as Disposition,
      file: b.file,
      lines: { baseline: b.line, head: null },
      exception: null,
    })),
  ];

  const exceptionEntries: RecordExceptionEntry[] = input.registry.map((r) => {
    const matches = (h: HeadSuppression) =>
      h.fingerprint === r.fingerprint &&
      h.suppressionType === r.suppression_type &&
      h.rule === r.rule;
    const used = head.some((h) => h.exception !== null && matches(h));
    const spent = head.some(
      (h) =>
        (h.disposition === "existing" || h.disposition === "moved-existing") &&
        matches(h),
    );
    let status: RecordExceptionEntry["status"] = "dangling";
    if (used) status = "used";
    else if (isExpired(r.expires, options.now ?? new Date())) status = "expired";
    else if (spent) status = "spent";
    return {
      fingerprint: r.fingerprint,
      suppressionType: r.suppression_type,
      rule: r.rule,
      file: r.file,
      type: r.type,
      status,
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    mode: options.mode,
    verdict,
    baseline: { ref: trees.baselineRef, tree: trees.baselineTree },
    proposedChange: {
      ref: options.mode === "check" ? "HEAD" : "index",
      tree: trees.proposedTree,
    },
    summary,
    inventory,
    exceptions: exceptionEntries,
    errors,
  };
}

function excludedResult(
  options: EvaluateOptions,
  trees: ResolvedTrees,
  policy: Policy,
): EvaluateResult {
  const record: EvaluationRecord = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    mode: options.mode,
    verdict: "excluded",
    baseline: { ref: trees.baselineRef, tree: trees.baselineTree },
    proposedChange: {
      ref: options.mode === "check" ? "HEAD" : "index",
      tree: trees.proposedTree,
    },
    summary: {
      policy: { enabled: policy.enabled, allowlist: policy.governedRules },
      governedRules: [],
      dispositions: { existing: 0, movedExisting: 0, removed: 0, new: 0, materiallyChanged: 0 },
      newDebt: { authorized: 0, unauthorized: 0 },
      cleanup: { danglingExceptions: 0, spentExceptions: 0, expiredExceptions: 0 },
    },
    inventory: [],
    exceptions: [],
    errors: [],
  };
  return { record, exitCode: 0, report: "" };
}

function emptySummary(): EvaluationSummary {
  return {
    policy: { enabled: true, allowlist: null },
    governedRules: [],
    dispositions: { existing: 0, movedExisting: 0, removed: 0, new: 0, materiallyChanged: 0 },
    newDebt: { authorized: 0, unauthorized: 0 },
    cleanup: { danglingExceptions: 0, spentExceptions: 0, expiredExceptions: 0 },
  };
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
        const norm = canonicalLine(line);
        if (norm.length > 0) index.add(norm);
      }
    }
  }
}

export type { SuppressionType, ErrorCode };
