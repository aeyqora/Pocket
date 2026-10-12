import type { ParsedInvocation } from "../args.js";
import type { CommandIo } from "../cli.js";
import type { LoadedConfig } from "../config.js";

/**
 * What every action command receives: the validated invocation, the loaded
 * action config, and the injected IO seam. `cli.ts` owns the exit code; a
 * command returns the code its run implies (0 success, 1 dry-run impact) or
 * throws an `OperationalError` for the top-level handler to map to 2.
 */
export interface ActionContext {
  parsed: ParsedInvocation;
  config: LoadedConfig;
  io: CommandIo;
}

/** A wired verb: its command file's entry point. */
export type ActionHandler = (context: ActionContext) => Promise<number>;
