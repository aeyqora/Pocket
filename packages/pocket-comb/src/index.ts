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
