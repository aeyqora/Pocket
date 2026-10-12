/** Public exports — kept small; the CLI is the product. */
export { VERSION } from "./version.js";
export { parseArgs, usage } from "./args.js";
export type { ParsedInvocation, ParseError, ParseResult } from "./args.js";
export { loadConfig, autoDetectConfig, isActionableRule } from "./config.js";
export type {
  LoadedConfig,
  LoadConfigOptions,
  PocketCombSettings,
  ReplacePair,
  ReportSetting,
} from "./config.js";
export { main, processIo } from "./cli.js";
export type { CommandIo } from "./cli.js";
export {
  OperationalError,
  UsageError,
  ConfigError,
  isOperationalError,
} from "./errors.js";
export { ACTIONS, REPORT_FORMATS } from "./types.js";
export type { Action, ReportFormat, RunMode } from "./types.js";
export { discover, DEFAULT_EXTENSIONS } from "./discovery.js";
export type { DiscoverOptions, DiscoverResult } from "./discovery.js";
export { createIsolatedESLint, lintFiles } from "./eslint.js";
export type {
  CreateIsolatedESLintOptions,
  DropKind,
  DroppedFile,
  FatalFile,
  LintFilesResult,
} from "./eslint.js";
export {
  runActionForFile,
  runBatch,
  scanSuppressFile,
  planSuppressEdits,
  applySuppressEdits,
  splitRuleList,
  ledgerRecordsForEdit,
  LINE_SUFFIX_DIRECTIVE_RE,
  NEXT_LINE_DIRECTIVE_RE,
} from "./engine.js";
export type {
  RunActionForFileOptions,
  RunActionResult,
  RunBatchOptions,
  RunBatchResult,
  StrategyParams,
  SuppressParams,
  SuppressPlan,
  SuppressTarget,
  SuppressEditKind,
  PlannedEdit,
  LineGuard,
  NextLineGuard,
  RuleList,
} from "./engine.js";
export {
  buildRunReport,
  rollupByRule,
  rollupByForm,
  rollupByFile,
  DIRECTIVE_FORMS,
} from "./ledger.js";
export type {
  RunMeta,
  RunReport,
  RuleCount,
  FormCount,
  FileCount,
} from "./ledger.js";
export { runPool, defaultWorkerCount, PoolRecoveryError, DEFAULT_BATCH_SIZE } from "./pool.js";
export type {
  Progress,
  RunPoolOptions,
  RunPoolResult,
  WorkerStat,
} from "./pool.js";
export type { BatchOutcome, DirectiveForm, EditRecord, EditType, JsonValue } from "./types.js";
export type {
  BatchDoneMessage,
  BatchFailedMessage,
  LintBatchMessage,
  ParentToWorker,
  ReadyMessage,
  WorkerInit,
  WorkerToParent,
} from "./worker.js";
export {
  createSpinner,
  formatCompletion,
  summarizeRun,
  writeCompletion,
} from "./ui.js";
export type { CompletionSummary, Spinner, SpinnerOptions } from "./ui.js";
