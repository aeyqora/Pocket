import { readFileSync, writeFileSync } from "node:fs";
import { lintFiles, type DroppedFile, type FatalFile } from "./eslint.js";
import type { ESLint } from "eslint";
import type {
  Action,
  BatchOutcome,
  EditRecord,
  JsonValue,
  LintMessage,
  RunMode,
} from "./types.js";

/**
 * Per-action strategy parameters. Suppress' shape is pinned here now; later
 * tickets add one type per action and widen the union additively.
 */
export type SuppressParams = {
  reason?: string;
  reuseBlocks?: boolean;
  fixFirst?: boolean;
};

export type StrategyParams = JsonValue;

/** The exact seam from the architecture notes: plan+apply for one file. */
export interface RunActionForFileOptions {
  action: Action;
  params: StrategyParams;
  filePath: string;
  text: string;
  messages: LintMessage[];
  /** Reserved: the caller owns the write; the strategy only reports the text. */
  apply: boolean;
}

export interface RunActionResult {
  /** The file's text after the strategy's plan. Equal to `text` when unchanged. */
  output: string;
  edits: EditRecord[];
  stats: Record<string, number>;
}

type Strategy = (options: RunActionForFileOptions) => RunActionResult;

/**
 * The action strategies, keyed by action. Ticket 03 ships only the `lint-only`
 * placeholder; ticket 05 fills in `suppress`, and later tickets add the rest.
 * Until a real strategy lands every action runs `lint-only`, so the pool, worker
 * and UI can be built and measured against a complete run without inventing
 * behaviour the spec has not pinned yet.
 */
const STRATEGIES: Partial<Record<Action, Strategy>> = {};

/**
 * Plan (and, when `apply`, apply) one file's action. Returns the new text plus
 * the ledger's edits and counters. In ticket 03 the only strategy is `lint-only`,
 * which edits nothing and just counts the file's messages.
 */
export function runActionForFile(options: RunActionForFileOptions): RunActionResult {
  const strategy = STRATEGIES[options.action] ?? lintOnly;
  return strategy(options);
}

/** The ticket-03 placeholder: no edits, only a message tally per file. */
function lintOnly(options: RunActionForFileOptions): RunActionResult {
  let errors = 0;
  let warnings = 0;
  for (const message of options.messages) {
    if (message.severity === 2) errors += 1;
    else warnings += 1;
  }
  return {
    output: options.text,
    edits: [],
    stats: { messages: options.messages.length, errors, warnings },
  };
}

export interface RunBatchOptions {
  action: Action;
  params: StrategyParams;
  mode: RunMode;
}

export interface RunBatchResult {
  outcomes: BatchOutcome[];
  dropped: DroppedFile[];
  fatal: FatalFile[];
}

/**
 * The shared hot path, used by the worker thread, the serial run, and the
 * main-thread recovery of a crashed worker's chunk alike: lint one batch
 * against the caller's persistent instance, run the action strategy per file,
 * and let the producing process own the write (spec §7). Keeping this in one
 * place means all three callers produce byte-identical outcomes.
 */
export async function runBatch(
  eslint: ESLint,
  files: string[],
  options: RunBatchOptions,
): Promise<RunBatchResult> {
  const { results, dropped, fatal } = await lintFiles(eslint, files);

  const outcomes: BatchOutcome[] = [];
  for (const result of results) {
    const text = readFileSync(result.filePath, "utf8");
    const planned = runActionForFile({
      action: options.action,
      params: options.params,
      filePath: result.filePath,
      text,
      messages: result.messages,
      apply: options.mode === "apply",
    });

    const changed = planned.output !== text;
    if (changed && options.mode === "apply") {
      writeFileSync(result.filePath, planned.output);
    }

    outcomes.push({
      filePath: result.filePath,
      messages: result.messages,
      edits: planned.edits,
      changed,
      // The planned text only travels back on a dry run; on apply it is on disk.
      ...(changed && options.mode === "dry-run" ? { output: planned.output } : {}),
      stats: planned.stats,
    });
  }

  return { outcomes, dropped, fatal };
}
