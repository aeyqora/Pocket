import type { ParsedInvocation } from "../args.js";
import type { CommandIo } from "../cli.js";
import type { LoadedConfig } from "../config.js";
import type { ReportResolver } from "../report/index.js";

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
  /**
   * The wizard's late report-resolution seam (spec §5 step 7). When present the
   * shared runner calls it after the run produced its data and before emitting
   * the report, so the report prompt lands after the dry-run impact summary
   * (spec §13). Absent for flags/settings/non-TTY runs, where the report resolves
   * from the invocation; the default path stays byte-identical.
   */
  resolveReport?: ReportResolver;
}

/** A wired verb: its command file's entry point. */
export type ActionHandler = (context: ActionContext) => Promise<number>;
