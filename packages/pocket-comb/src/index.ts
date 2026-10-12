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
export type { CommandIo, MainDeps } from "./cli.js";
export {
  OperationalError,
  UsageError,
  ConfigError,
  NotImplementedError,
  isOperationalError,
} from "./errors.js";
export { ACTIONS, REPORT_FORMATS, EDIT_TYPES, BARE_RULE } from "./types.js";
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
  findEnclosingBlockGuard,
  splitRuleList,
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
  BlockGuard,
  RuleList,
  RemoveParams,
  ReplaceParams,
  CleanupParams,
} from "./engine.js";
export {
  scanDirectives,
  formatDirective,
  directiveName,
} from "./scan.js";
export type { ScannedDirective } from "./scan.js";
export { censusFiles, censusFileScan } from "./census.js";
export type { CensusEntry, CensusFileScan, CensusInput, CensusResult } from "./census.js";
export {
  buildRunReport,
  orderEdits,
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
export {
  DEFAULT_REPORT_BASENAME,
  defaultReportPath,
  emitReport,
  isCensusReport,
  renderCsv,
  renderHtml,
  renderJson,
  renderReport,
  resolveReportOptions,
} from "./report/index.js";
export type {
  CensusReport,
  CensusTotal,
  EmitReportOptions,
  EmitReportResult,
  ReportData,
  ReportOptionsInput,
  ResolvedReportOptions,
} from "./report/index.js";
export { runPool, defaultWorkerCount, PoolRecoveryError, DEFAULT_BATCH_SIZE } from "./pool.js";
export type {
  Progress,
  RunPoolOptions,
  RunPoolResult,
  WorkerStat,
} from "./pool.js";
export type { BatchOutcome, DirectiveForm, EditRecord, EditType, JsonValue, NotActionableDirective } from "./types.js";
export {
  createSpinner,
  formatCompletion,
  formatCensusSummary,
  formatImpactSummary,
  summarizeImpact,
  summarizeRun,
  writeCompletion,
  writeCensusSummary,
  writeImpactSummary,
  writeNotActionable,
} from "./ui.js";
export type {
  CensusSummary,
  CompletionSummary,
  ImpactRuleCount,
  ImpactSummary,
  ImpactTypeCount,
  Spinner,
  SpinnerOptions,
} from "./ui.js";
export { runAction } from "./actions/index.js";
export type { ActionContext, ActionHandler } from "./actions/action.js";
export {
  WIZARD_CANCEL,
  createClackPrompter,
  isCancelled,
  runWizard,
} from "./wizard.js";
export type {
  Answer,
  CancelSignal,
  ConfirmPrompt,
  PathPrompt,
  Prompter,
  SelectChoice,
  SelectPrompt,
  TextPrompt,
  WizardDeps,
  WizardRunContext,
} from "./wizard.js";
