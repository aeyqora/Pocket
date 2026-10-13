import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  cancel as clackCancel,
  confirm as clackConfirm,
  intro as clackIntro,
  isCancel as clackIsCancel,
  outro as clackOutro,
  path as clackPath,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { autoDetectConfig, configOptionsFor, resolveTarget } from "./config.js";
import { defaultReportPath, resolveReportOptions } from "./report/index.js";
import { ACTIONS, REPORT_FORMATS } from "./types.js";
import type { ParsedInvocation } from "./args.js";
import type { CommandIo } from "./cli.js";
import type { LoadConfigOptions, LoadedConfig, ReplacePair } from "./config.js";
import type { ReportResolver, ResolvedReportOptions } from "./report/index.js";
import type { Action, ReportFormat, RunMode } from "./types.js";
import type { Readable, Writable } from "node:stream";

/**
 * The wizard's cancellation sentinel. clack answers every prompt with a symbol on
 * Ctrl-C; the `Prompter` seam normalises that to one exported symbol so the flow's
 * `isCancelled` guards are testable without a real TTY (a fake prompter just
 * returns `WIZARD_CANCEL`).
 */
export const WIZARD_CANCEL: unique symbol = Symbol("pocket-comb.wizard.cancel");

export type CancelSignal = typeof WIZARD_CANCEL;

/** A prompt answer: the value, or the cancel sentinel. */
export type Answer<T> = T | CancelSignal;

export function isCancelled<T>(value: Answer<T>): value is CancelSignal {
  return value === WIZARD_CANCEL;
}

/** One choice in a `select` prompt. */
export interface SelectChoice {
  value: string;
  label: string;
  hint?: string;
}

export interface SelectPrompt {
  message: string;
  options: SelectChoice[];
  initialValue?: string;
}

export interface TextPrompt {
  message: string;
  placeholder?: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined | Promise<string | undefined>;
}

export interface ConfirmPrompt {
  message: string;
  initialValue?: boolean;
}

export interface PathPrompt {
  message: string;
  root?: string;
  directory?: boolean;
  initialValue?: string;
  validate?: (value: string) => string | undefined | Promise<string | undefined>;
}

/**
 * The prompt primitives the wizard is built on (spec §5). The default
 * implementation wraps `@clack/prompts`; tests inject a fake, so the whole flow
 * is exercised without a TTY. clack's own `spinner` is deliberately not imported
 * — the spinner is hand-rolled in `ui.ts`.
 */
export interface Prompter {
  intro(title: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  select(prompt: SelectPrompt): Promise<Answer<string>>;
  text(prompt: TextPrompt): Promise<Answer<string>>;
  confirm(prompt: ConfirmPrompt): Promise<Answer<boolean>>;
  path(prompt: PathPrompt): Promise<Answer<string>>;
}

function wrap<T>(value: T | symbol): Answer<T> {
  return clackIsCancel(value) ? WIZARD_CANCEL : (value as T);
}

function clackValidate(
  validate: PathPrompt["validate"],
): ((value: string | undefined) => string | undefined | Promise<string | undefined>) | undefined {
  if (validate === undefined) return undefined;
  return (value) => validate(value ?? "");
}

/**
 * The production `Prompter`: `@clack/prompts`, wired to the injected IO streams
 * so the CLI's IO seam stays the single place a terminal is reached for.
 */
export function createClackPrompter(io: CommandIo): Prompter {
  const streams = { input: io.input as Readable, output: io.output as Writable };
  const frame = { output: io.output as Writable };
  return {
    intro: (title) => clackIntro(title, frame),
    outro: (message) => clackOutro(message, frame),
    cancel: (message) => clackCancel(message, frame),
    select: async (prompt) =>
      wrap<string>(
        await clackSelect({
          message: prompt.message,
          options: prompt.options,
          ...(prompt.initialValue !== undefined ? { initialValue: prompt.initialValue } : {}),
          ...streams,
        }),
      ),
    text: async (prompt) => {
      const validate = clackValidate(prompt.validate);
      return wrap<string>(
        await clackText({
          message: prompt.message,
          ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
          ...(prompt.initialValue !== undefined ? { initialValue: prompt.initialValue } : {}),
          ...(validate !== undefined ? { validate } : {}),
          ...streams,
        }),
      );
    },
    confirm: async (prompt) =>
      wrap<boolean>(
        await clackConfirm({
          message: prompt.message,
          ...(prompt.initialValue !== undefined ? { initialValue: prompt.initialValue } : {}),
          ...streams,
        }),
      ),
    path: async (prompt) => {
      const validate = clackValidate(prompt.validate);
      return wrap<string>(
        await clackPath({
          message: prompt.message,
          ...(prompt.root !== undefined ? { root: prompt.root } : {}),
          ...(prompt.directory !== undefined ? { directory: prompt.directory } : {}),
          ...(prompt.initialValue !== undefined ? { initialValue: prompt.initialValue } : {}),
          ...(validate !== undefined ? { validate } : {}),
          ...streams,
        }),
      );
    },
  };
}

/** One resolved invocation handed to the run callback. */
export interface WizardRunContext {
  parsed: ParsedInvocation;
  config: LoadedConfig;
  /**
   * The report prompt seam (spec §5 step 7), supplied only when the report is a
   * gap. The run callback forwards it to the action pipeline, which calls it
   * after the run produced its data so the impact summary prints first (§13).
   */
  resolveReport?: ReportResolver;
}

export interface WizardDeps {
  parsed: ParsedInvocation;
  io: CommandIo;
  cwd: string;
  prompter: Prompter;
  /** Load + validate the action config; injectable so tests need no filesystem. */
  loadConfig: (options: LoadConfigOptions) => Promise<LoadedConfig>;
  /** Dispatch one resolved invocation; returns the action's exit code (0/1). */
  run: (context: WizardRunContext) => Promise<number>;
}

const ACTION_HINTS: Record<Action, string> = {
  suppress: "insert/prepend disable directives",
  fix: "autofix the config's rules",
  remove: "strip the config's rules from directives",
  replace: "rename rule tokens",
  cleanup: "prune unused directives",
  inventory: "read-only census",
};

const NEXT_OPTIONS: SelectChoice[] = [
  { value: "apply", label: "Apply now", hint: "re-run in apply mode" },
  { value: "restart", label: "Restart", hint: "change the answers" },
  { value: "abort", label: "Abort", hint: "leave the target untouched" },
];

function nonEmpty(value: string): string | undefined {
  return value.trim() === "" ? "a value is required" : undefined;
}

/**
 * The interactive session (spec §5): fill only the gaps flags and settings leave,
 * run the chosen action, then offer apply/restart/abort after a dry run. Entered
 * by `cli.ts` only on a TTY; a non-TTY run never reaches here.
 *
 * The report prompt (step 7) is asked *inside* the run, via the `resolveReport`
 * hook the run callback forwards to the pipeline, so the dry-run impact summary
 * (step 6, §13) always prints before it. A cancel at any pre-run prompt exits
 * cleanly (exit 0) without running the action; a cancel at the post-run report
 * prompt keeps the run's exit code.
 */
export async function runWizard(deps: WizardDeps): Promise<number> {
  const { cwd, prompter } = deps;
  const base = deps.parsed;
  let introShown = false;

  const showIntro = (): void => {
    if (!introShown) {
      prompter.intro("pocket-comb");
      introShown = true;
    }
  };
  const finish = (code: number): number => {
    if (introShown) prompter.outro("Done");
    return code;
  };
  const cancelled = (): number => {
    prompter.cancel("Cancelled");
    return 0;
  };

  // `restart` loops back here with the original invocation, so flags keep
  // bypassing their prompts and only the real gaps are re-asked.
  for (;;) {
    let action = base.action;
    if (action === null) {
      showIntro();
      const answer = await prompter.select({
        message: "Which action?",
        options: ACTIONS.map((value) => ({ value, label: value, hint: ACTION_HINTS[value] })),
      });
      if (isCancelled(answer)) return cancelled();
      action = answer as Action;
    }

    // 2. config: prompted whenever `--config` is absent, pre-filled from the cwd
    //    convention. The prompt validates existence and loadability.
    let configFlag = base.config;
    if (configFlag === null) {
      showIntro();
      const detected = autoDetectConfig(cwd);
      const answer = await prompter.path({
        message: "Action config",
        root: cwd,
        initialValue: detected ?? cwd,
        validate: (value) => validateConfig(value, cwd, deps.loadConfig),
      });
      if (isCancelled(answer)) return cancelled();
      configFlag = answer;
    }

    // Load once for the settings that decide the remaining gaps. Flags were
    // already merged in by the caller's `parsed`; `loadConfig` applies
    // flag > settings precedence.
    const loaded = await deps.loadConfig(configOptionsFor(base, cwd, configFlag));

    // 3. target: prompted only when neither `--target` nor `settings.target`
    //    answers it. `directory: true`, pre-filled from the resolved target/cwd.
    let targetFlag = base.target;
    if (targetFlag === null && loaded.settings.target === undefined) {
      showIntro();
      const answer = await prompter.path({
        message: "Target directory",
        root: cwd,
        directory: true,
        initialValue: loaded.targetRoot,
        validate: (value) => validateDirectory(value, cwd),
      });
      if (isCancelled(answer)) return cancelled();
      targetFlag = answer;
    }

    // 4. replace pair: only when the action is `replace` and neither flags nor
    //    settings carry it.
    let from = base.from;
    let to = base.to;
    let wizardPair: ReplacePair | undefined;
    if (action === "replace" && from === null && loaded.replace === undefined) {
      showIntro();
      const fromAnswer = await prompter.text({
        message: "Rule to rename (from)",
        validate: nonEmpty,
      });
      if (isCancelled(fromAnswer)) return cancelled();
      const toAnswer = await prompter.text({
        message: "New rule name (to)",
        validate: nonEmpty,
      });
      if (isCancelled(toAnswer)) return cancelled();
      from = fromAnswer;
      to = toAnswer;
      wizardPair = { from, to };
    }

    // 5. dry-run or apply: skipped for the read-only census and whenever
    //    `--dry-run`/`--apply` already answered it.
    let mode: RunMode | null = base.mode;
    if (action !== "inventory" && mode === null) {
      showIntro();
      const answer = await prompter.confirm({
        message: "Apply changes? (No = dry run)",
        initialValue: false,
      });
      if (isCancelled(answer)) return cancelled();
      mode = answer ? "apply" : "dry-run";
    }

    // 6. report: the prompt is asked only when neither `settings.report` nor the
    //    `--format`/`--out`/`--no-report` flags carry it — but it is asked
    //    *after* the run (step 7), so the dry-run impact summary prints first
    //    (spec §5 step 7, §13). The `resolveReport` hook below is that seam: the
    //    runner calls it once the run has produced its report data, before it
    //    emits the report.
    const reportCarried =
      base.noReport || base.format !== null || base.out !== null || loaded.report !== undefined;
    let resolvedReport: ResolvedReportOptions | undefined;
    let reportCancelled = false;
    const resolveReport: ReportResolver | undefined = reportCarried
      ? undefined
      : async () => {
          // Cache: the apply re-run (step 8) reuses the answer rather than
          // re-asking.
          if (resolvedReport !== undefined) return resolvedReport;
          showIntro();
          const formatAnswer = await prompter.select({
            message: "Report format",
            options: REPORT_FORMATS.map((value) => ({ value, label: value })),
            initialValue: "html",
          });
          if (isCancelled(formatAnswer)) {
            reportCancelled = true;
            return (resolvedReport = resolveReportOptions({ noReport: true, cwd }));
          }
          const format = formatAnswer as ReportFormat;
          // The report destination is a path the run will create, not one that
          // must already exist, so it must not be a `path` prompt: clack's `path`
          // is an autocomplete over on-disk entries and rejects a new filename
          // ("No matches found"). A `text` prompt also accepts `-` for stdout.
          const outAnswer = await prompter.text({
            message: "Report output",
            initialValue: defaultReportPath(cwd, format),
            validate: nonEmpty,
          });
          if (isCancelled(outAnswer)) {
            reportCancelled = true;
            return (resolvedReport = resolveReportOptions({ noReport: true, cwd }));
          }
          // Resolve through the shared rules: a relative answer resolves against
          // the wizard's cwd, and `-` stays the stdout sentinel.
          return (resolvedReport = resolveReportOptions({
            formatFlag: format,
            outFlag: outAnswer,
            cwd,
          }));
        };

    const finalParsed: ParsedInvocation = {
      ...base,
      action,
      config: configFlag,
      target: targetFlag,
      from,
      to,
      mode,
    };
    const finalConfig: LoadedConfig = {
      ...loaded,
      targetRoot:
        targetFlag !== null && targetFlag !== base.target
          ? resolveTarget(targetFlag, loaded.settings, loaded.configPath, cwd)
          : loaded.targetRoot,
      ...(wizardPair !== undefined ? { replace: wizardPair } : {}),
    };

    // 7. run, with the action's own spinner and completion line. The report
    //    prompt (step 6's gap) fires inside the run, after the impact summary.
    const code = await deps.run({
      parsed: finalParsed,
      config: finalConfig,
      ...(resolveReport !== undefined ? { resolveReport } : {}),
    });

    if (reportCancelled) {
      // The run already happened; a cancel here declines the report only. The
      // dry-run exit code stands, exactly like the post-run prompt's cancel.
      prompter.cancel("Cancelled");
      return finish(code);
    }

    // 8. after an interactive dry run, offer apply now / restart / abort. All
    //    actions are idempotent, so re-running in apply mode is safe. An explicit
    //    `--dry-run` is terminal: the user already chose to stop after the dry
    //    run, so re-run with `--apply` instead of offering it.
    const explicitDryRun = base.mode === "dry-run";
    if (mode !== "dry-run" || explicitDryRun || action === "inventory") return finish(code);
    showIntro();
    const next = await prompter.select({ message: "Next", options: NEXT_OPTIONS });
    if (isCancelled(next)) {
      // The dry run already printed its impact; a cancel here declines the
      // apply, so the dry-run exit code stands.
      prompter.cancel("Cancelled");
      return finish(code);
    }
    if (next === "apply") {
      const applied = await deps.run({
        parsed: { ...finalParsed, mode: "apply" },
        config: finalConfig,
        // The report answer is cached, so the apply run re-emits the report
        // without re-asking (spec §5 step 8).
        ...(resolveReport !== undefined ? { resolveReport } : {}),
      });
      return finish(applied);
    }
    if (next === "abort") return finish(code);
    // restart: loop back to the top with the original invocation.
  }
}

async function validateConfig(
  value: string,
  cwd: string,
  loadConfig: WizardDeps["loadConfig"],
): Promise<string | undefined> {
  const path = isAbsolute(value) ? value : resolve(cwd, value);
  if (!existsSync(path)) return `no such file: ${path}`;
  try {
    await loadConfig({ configFlag: path, cwd });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function validateDirectory(value: string, cwd: string): string | undefined {
  const path = isAbsolute(value) ? value : resolve(cwd, value);
  if (!existsSync(path)) return `no such directory: ${path}`;
  try {
    return statSync(path).isDirectory() ? undefined : `not a directory: ${path}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
