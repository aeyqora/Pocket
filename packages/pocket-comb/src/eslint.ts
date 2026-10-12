import { ESLint, type Linter } from "eslint";

type LintMessage = Linter.LintMessage;
type LintResult = ESLint.LintResult;

/** Why an explicitly passed file never reached the linter (spec §10). */
export type DropKind = "ignored" | "unconfigured" | "external";

export interface DroppedFile {
  /** Absolute path exactly as it was passed to `lintFiles`. */
  filePath: string;
  kind: DropKind;
}

/** A file whose parse failed: reported and skipped, never a crash (spec §12). */
export interface FatalFile {
  filePath: string;
  message: string;
}

export interface LintFilesResult {
  /** Results actually linted, with synthetic ignored-file warnings removed. */
  results: LintResult[];
  /** Explicitly passed files ESLint filtered out, classified. */
  dropped: DroppedFile[];
  /** Files with a fatal parse message, reported and skipped. */
  fatal: FatalFile[];
}

export interface CreateIsolatedESLintOptions {
  /** Absolute action-config path. */
  configPath: string;
  /** Absolute resolved target root; the config's relative globs resolve here. */
  cwd: string;
  fix?: boolean;
}

/**
 * The exact isolated instance from spec §10. `overrideConfigFile` (a string)
 * makes ESLint skip config search entirely, so the target repo's own
 * `eslint.config.*` is never read. `applySuppressions` is deliberately unset so
 * a stray `eslint-suppressions.json` in the target can never mask violations.
 */
export function createIsolatedESLint(options: CreateIsolatedESLintOptions): ESLint {
  return new ESLint({
    overrideConfigFile: options.configPath,
    cwd: options.cwd,
    ...(options.fix === true ? { fix: true } : {}),
  });
}

/**
 * Lint an explicit absolute file list. The `never`-typed third parameter is a
 * compile-time guard: callers may never pass a `warnIgnored` override, because
 * `warnIgnored: false` silently hides skips rather than fixing them. Drops are
 * therefore always surfaced as classified results.
 */
export async function lintFiles(
  eslint: ESLint,
  files: string[],
  warnIgnoredIgnored?: never,
): Promise<LintFilesResult> {
  void warnIgnoredIgnored;
  const linted = await eslint.lintFiles(files);

  const results: LintResult[] = [];
  const dropped: DroppedFile[] = [];
  const fatal: FatalFile[] = [];
  const returned = new Set<string>();

  for (const result of linted) {
    returned.add(result.filePath);

    const synthetic = result.messages.filter(isSyntheticIgnoredFile);
    const actionable = result.messages.filter((message) => !isSyntheticIgnoredFile(message));

    if (synthetic.length > 0 && actionable.length === 0) {
      // A purely synthetic result: the file was never linted.
      dropped.push({ filePath: result.filePath, kind: classifySynthetic(synthetic[0]!) });
      continue;
    }
    for (const message of synthetic) {
      dropped.push({ filePath: result.filePath, kind: classifySynthetic(message) });
    }

    const parseErrors = actionable.filter((message) => message.fatal === true);
    if (parseErrors.length > 0) {
      // Reported and skipped: never crash the run, never feed the engine a
      // half-parsed file.
      for (const message of parseErrors) {
        fatal.push({ filePath: result.filePath, message: message.message });
      }
      continue;
    }

    results.push({ ...result, messages: actionable });
  }

  // With `warnIgnored` left at its default (true) every drop carries a synthetic
  // result, so this fallback is defensive: it guarantees no input file vanishes
  // silently even if a future ESLint version changes the warning behaviour.
  for (const file of files) {
    if (!returned.has(file)) dropped.push({ filePath: file, kind: "ignored" });
  }

  return { results, dropped, fatal };
}

const SYNTHETIC_PREFIX = "File ignored";

/**
 * The synthetic ignored-file warning: `ruleId` null and no `line`/`column` (a
 * naive all-warnings pass would treat it as a violation). Unused-directive
 * messages are also `ruleId` null but do carry a location, so they are safe.
 */
function isSyntheticIgnoredFile(message: LintMessage): boolean {
  return (
    message.ruleId === null &&
    message.line === undefined &&
    message.column === undefined &&
    typeof message.message === "string" &&
    message.message.startsWith(SYNTHETIC_PREFIX)
  );
}

function classifySynthetic(message: LintMessage): DropKind {
  if (message.message.includes("no matching configuration")) return "unconfigured";
  if (message.message.includes("outside of base path")) return "external";
  return "ignored";
}
