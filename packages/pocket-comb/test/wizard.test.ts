import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { main } from "../src/cli.js";
import {
  WIZARD_CANCEL,
  runWizard,
  type Answer,
  type ConfirmPrompt,
  type PathPrompt,
  type Prompter,
  type SelectPrompt,
  type TextPrompt,
} from "../src/wizard.js";
import { cleanupTemps, fakeIo, tempDir, write } from "./harness.js";
import type { ParsedInvocation } from "../src/args.js";
import type { LoadedConfig } from "../src/config.js";

after(cleanupTemps);

const ACTIONS = ["suppress", "fix", "remove", "replace", "cleanup", "inventory"];

/** A scripted `Prompter`: records every call, returns queued answers in order. */
class FakePrompter implements Prompter {
  readonly calls: Array<{ kind: string; options: unknown }> = [];
  readonly selects: Answer<string>[] = [];
  readonly texts: Answer<string>[] = [];
  readonly confirms: Answer<boolean>[] = [];
  readonly paths: Answer<string>[] = [];

  intro(title: string): void {
    this.calls.push({ kind: "intro", options: title });
  }
  outro(message: string): void {
    this.calls.push({ kind: "outro", options: message });
  }
  cancel(message: string): void {
    this.calls.push({ kind: "cancel", options: message });
  }
  async select(prompt: SelectPrompt): Promise<Answer<string>> {
    this.calls.push({ kind: "select", options: prompt });
    return next(this.selects, "select");
  }
  async text(prompt: TextPrompt): Promise<Answer<string>> {
    this.calls.push({ kind: "text", options: prompt });
    return next(this.texts, "text");
  }
  async confirm(prompt: ConfirmPrompt): Promise<Answer<boolean>> {
    this.calls.push({ kind: "confirm", options: prompt });
    return next(this.confirms, "confirm");
  }
  async path(prompt: PathPrompt): Promise<Answer<string>> {
    this.calls.push({ kind: "path", options: prompt });
    return next(this.paths, "path");
  }
}

function next<T>(queue: Answer<T>[], kind: string): Answer<T> {
  if (queue.length === 0) throw new Error(`FakePrompter: no scripted ${kind} answer`);
  return queue.shift()!;
}

function callsOf(prompter: FakePrompter, kind: string): Array<{ kind: string; options: unknown }> {
  return prompter.calls.filter((call) => call.kind === kind);
}

function promptsOf<T>(prompter: FakePrompter, kind: string): T[] {
  return callsOf(prompter, kind).map((call) => call.options as T);
}

function invocation(overrides: Partial<ParsedInvocation> = {}): ParsedInvocation {
  return {
    kind: "invocation",
    action: "suppress",
    help: false,
    version: false,
    config: null,
    target: null,
    mode: null,
    from: null,
    to: null,
    reason: null,
    fixFirst: false,
    reuseBlocks: false,
    format: null,
    out: null,
    noReport: false,
    workers: null,
    serial: false,
    batchSize: null,
    extensions: null,
    ...overrides,
  };
}

function stubConfig(overrides: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    configPath: "/tmp/pocket-comb.config.mjs",
    configHash: "deadbeef",
    targetRoot: "/tmp/target",
    rules: [],
    settings: {},
    rawConfig: [],
    ...overrides,
  };
}

interface RunRecord {
  parsed: ParsedInvocation;
  config: LoadedConfig;
}

/** Drive `runWizard` with a scripted prompter, a stubbed loader and a recording run. */
async function drive(options: {
  parsed: ParsedInvocation;
  prompter: FakePrompter;
  cwd: string;
  config?: LoadedConfig;
  codes?: number[];
}): Promise<{ code: number; runs: RunRecord[]; io: ReturnType<typeof fakeIo> }> {
  const runs: RunRecord[] = [];
  const codes = options.codes ?? [0];
  let index = 0;
  const io = fakeIo({ cwd: options.cwd, tty: true });
  const code = await runWizard({
    parsed: options.parsed,
    io: io.io,
    cwd: options.cwd,
    prompter: options.prompter,
    loadConfig: async () => options.config ?? stubConfig(),
    run: async (context) => {
      runs.push(context);
      const value = codes[Math.min(index, codes.length - 1)] ?? 0;
      index += 1;
      return value;
    },
  });
  return { code, runs, io };
}

test("a bare session selects the action when no verb is given", async () => {
  const dir = tempDir();
  const p = new FakePrompter();
  p.selects.push("suppress"); // action select
  p.paths.push(join(dir, "comb.config.mjs")); // config path
  p.paths.push(dir); // target path
  p.confirms.push(false); // dry run
  p.selects.push("html"); // report format
  p.paths.push(join(dir, "report.html")); // report out
  p.selects.push("abort"); // after the dry run

  const { code, runs } = await drive({ parsed: invocation({ action: null }), prompter: p, cwd: dir, config: stubConfig({ targetRoot: dir }) });

  const first = promptsOf<SelectPrompt>(p, "select")[0]!;
  assert.deepEqual(
    first.options.map((option) => option.value),
    ACTIONS,
    "the action select offers the six verbs",
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.parsed.action, "suppress");
  assert.equal(code, 0, "abort after the dry run returns cleanly");
});

test("prompts appear only for gaps; carried values pass through untouched", async () => {
  const dir = tempDir();
  const configPath = join(dir, "comb.config.mjs");
  const p = new FakePrompter();
  p.confirms.push(false); // the one gap: dry-run/apply
  p.selects.push("abort"); // after the dry run

  const { runs } = await drive({
    parsed: invocation({
      action: "suppress",
      config: configPath,
      target: dir,
      noReport: true,
    }),
    prompter: p,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
  });

  assert.equal(callsOf(p, "path").length, 0, "no path prompt when --config and --target are carried");
  assert.equal(callsOf(p, "text").length, 0);
  assert.equal(promptsOf<ConfirmPrompt>(p, "confirm").length, 1, "only the dry-run/apply gap is asked");
  assert.equal(runs[0]!.parsed.mode, "dry-run");
  assert.equal(runs[0]!.parsed.config, configPath);
  assert.equal(runs[0]!.parsed.target, dir);
});

test("path prompts autocomplete directories, default to cwd, and keep relative paths", async () => {
  const dir = tempDir();
  const p = new FakePrompter();
  p.paths.push(join(dir, "comb.config.mjs")); // config
  p.paths.push("relative/target"); // target, typed relative
  p.confirms.push(true); // apply

  const { runs } = await drive({
    parsed: invocation({ action: "fix", noReport: true }),
    prompter: p,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
  });

  const paths = promptsOf<PathPrompt>(p, "path");
  assert.equal(paths[0]!.root, dir, "the config prompt roots at the cwd");
  assert.equal(paths[0]!.initialValue, dir, "with no detection, the config prompt defaults to cwd");
  assert.equal(paths[1]!.directory, true, "the target prompt is directory-only");
  assert.equal(paths[1]!.root, dir);
  assert.equal(paths[1]!.initialValue, dir, "the target prompt defaults to the cwd");
  assert.equal(runs[0]!.parsed.target, "relative/target", "a relative target answer is preserved");
  assert.equal(runs[0]!.parsed.mode, "apply");
});

test("the config path prompt pre-fills from auto-detection", async () => {
  const dir = tempDir();
  const detected = write(dir, "pocket-comb.config.mjs", "export default [{ rules: {} }];\n");
  const p = new FakePrompter();
  p.paths.push(detected);
  p.confirms.push(true);

  await drive({ parsed: invocation({ action: "fix", target: dir, noReport: true }), prompter: p, cwd: dir, config: stubConfig({ targetRoot: dir }) });

  const configPrompt = promptsOf<PathPrompt>(p, "path")[0]!;
  assert.equal(configPrompt.initialValue, detected, "the auto-detected config pre-fills the prompt");
});

test("the config path prompt rejects a path that does not exist", async () => {
  const dir = tempDir();
  const p = new FakePrompter();
  p.paths.push(dir);
  p.confirms.push(true);

  await drive({ parsed: invocation({ action: "fix", target: dir, noReport: true }), prompter: p, cwd: dir, config: stubConfig({ targetRoot: dir }) });
  const validate = promptsOf<PathPrompt>(p, "path")[0]!.validate!;
  const error = await validate(join(dir, "nope.config.mjs"));
  assert.equal(typeof error, "string");
});

test("the target path prompt rejects a non-directory", async () => {
  const dir = tempDir();
  const file = write(dir, "a.js", "// x\n");
  const p = new FakePrompter();
  p.paths.push(join(dir, "comb.config.mjs"));
  p.paths.push(file);
  p.confirms.push(true);

  await drive({ parsed: invocation({ action: "fix", noReport: true }), prompter: p, cwd: dir, config: stubConfig({ targetRoot: dir }) });
  const validate = promptsOf<PathPrompt>(p, "path")[1]!.validate!;
  const error = await validate(file);
  assert.equal(typeof error, "string");
});

test("the replace prompts appear only when neither flags nor settings carry the pair", async () => {
  const dir = tempDir();

  // Settings carry the pair: no text prompts.
  const withSettings = new FakePrompter();
  withSettings.confirms.push(true);
  await drive({
    parsed: invocation({ action: "replace", config: join(dir, "c.mjs"), target: dir, noReport: true }),
    prompter: withSettings,
    cwd: dir,
    config: stubConfig({ targetRoot: dir, settings: { replace: { from: "a", to: "b" } }, replace: { from: "a", to: "b" } }),
  });
  assert.equal(callsOf(withSettings, "text").length, 0, "settings.replace suppresses the pair prompts");

  // Flags carry the pair: no text prompts.
  const withFlags = new FakePrompter();
  withFlags.confirms.push(true);
  await drive({
    parsed: invocation({ action: "replace", config: join(dir, "c.mjs"), target: dir, noReport: true, from: "a", to: "b" }),
    prompter: withFlags,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
  });
  assert.equal(callsOf(withFlags, "text").length, 0, "--from/--to suppress the pair prompts");

  // Neither carries it: two text prompts, fed into the run's config.
  const gaps = new FakePrompter();
  gaps.texts.push("old/rule");
  gaps.texts.push("new/rule");
  gaps.confirms.push(true);
  const { runs } = await drive({
    parsed: invocation({ action: "replace", config: join(dir, "c.mjs"), target: dir, noReport: true }),
    prompter: gaps,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
  });
  assert.equal(callsOf(gaps, "text").length, 2);
  assert.deepEqual(runs[0]!.config.replace, { from: "old/rule", to: "new/rule" });
});

test("the dry-run flow applies now by re-running in apply mode", async () => {
  const dir = tempDir();
  const p = new FakePrompter();
  p.confirms.push(false); // dry run
  p.selects.push("apply"); // apply now

  const { runs } = await drive({
    parsed: invocation({ action: "suppress", config: join(dir, "c.mjs"), target: dir, noReport: true }),
    prompter: p,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
    codes: [1, 0],
  });

  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.parsed.mode, "dry-run");
  assert.equal(runs[1]!.parsed.mode, "apply", "apply re-runs the same invocation in apply mode");
});

test("the dry-run flow restarts the session on request", async () => {
  const dir = tempDir();
  const p = new FakePrompter();
  p.confirms.push(false); // dry run
  p.selects.push("restart"); // restart
  p.confirms.push(true); // then apply

  const { runs } = await drive({
    parsed: invocation({ action: "suppress", config: join(dir, "c.mjs"), target: dir, noReport: true }),
    prompter: p,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
    codes: [1, 0],
  });

  assert.equal(promptsOf<ConfirmPrompt>(p, "confirm").length, 2, "restart re-asks the gap");
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.parsed.mode, "dry-run");
  assert.equal(runs[1]!.parsed.mode, "apply");
});

test("the dry-run flow aborts and returns the dry-run exit code", async () => {
  const dir = tempDir();
  const p = new FakePrompter();
  p.confirms.push(false);
  p.selects.push("abort");

  const { code, runs } = await drive({
    parsed: invocation({ action: "suppress", config: join(dir, "c.mjs"), target: dir, noReport: true }),
    prompter: p,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
    codes: [1],
  });

  assert.equal(runs.length, 1);
  assert.equal(code, 1, "the CI probe exit code survives an abort");
});

test("inventory is never asked dry-run-or-apply", async () => {
  const dir = tempDir();
  const p = new FakePrompter();
  const { runs } = await drive({
    parsed: invocation({ action: "inventory", config: join(dir, "c.mjs"), target: dir, noReport: true }),
    prompter: p,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
  });

  assert.equal(callsOf(p, "confirm").length, 0, "a read-only census has no mode question");
  assert.equal(callsOf(p, "select").length, 0, "and no post-run question");
  assert.equal(runs[0]!.parsed.mode, null);
});

test("the report prompt is skipped when settings or flags carry it", async () => {
  const dir = tempDir();

  const withSetting = new FakePrompter();
  withSetting.confirms.push(true);
  await drive({
    parsed: invocation({ action: "fix", config: join(dir, "c.mjs"), target: dir }),
    prompter: withSetting,
    cwd: dir,
    config: stubConfig({ targetRoot: dir, settings: { report: { format: "csv", out: "r.csv" } }, report: { format: "csv", out: "r.csv" } }),
  });
  assert.equal(callsOf(withSetting, "select").length, 0, "settings.report suppresses the report prompts");

  const withFlags = new FakePrompter();
  withFlags.confirms.push(true);
  await drive({
    parsed: invocation({ action: "fix", config: join(dir, "c.mjs"), target: dir, format: "json", out: "-" }),
    prompter: withFlags,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
  });
  assert.equal(callsOf(withFlags, "select").length, 0, "--format/--out suppress the report prompts");

  const withNoReport = new FakePrompter();
  withNoReport.confirms.push(true);
  await drive({
    parsed: invocation({ action: "fix", config: join(dir, "c.mjs"), target: dir, noReport: true }),
    prompter: withNoReport,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
  });
  assert.equal(callsOf(withNoReport, "select").length, 0, "--no-report suppresses the report prompts");
});

test("the report prompt asks format (html default) then the out path", async () => {
  const dir = tempDir();
  const p = new FakePrompter();
  p.confirms.push(true);
  p.selects.push("csv"); // format select
  p.paths.push("out/report.csv"); // out path

  const { runs } = await drive({
    parsed: invocation({ action: "fix", config: join(dir, "c.mjs"), target: dir }),
    prompter: p,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
  });

  const format = promptsOf<SelectPrompt>(p, "select")[0]!;
  assert.equal(format.initialValue, "html", "the format select defaults to html");
  const out = promptsOf<PathPrompt>(p, "path")[0]!;
  assert.equal(out.directory, false, "the report out prompt is a file path");
  assert.equal(runs[0]!.parsed.format, "csv");
  assert.equal(runs[0]!.parsed.out, "out/report.csv");
});

test("cancel at any prompt exits cleanly without running", async () => {
  const dir = tempDir();
  const cases: Array<{ name: string; script: (p: FakePrompter) => void; parsed: Partial<ParsedInvocation> }> = [
    { name: "action", script: (p) => p.selects.push(WIZARD_CANCEL), parsed: { action: null } },
    { name: "config", script: (p) => p.paths.push(WIZARD_CANCEL), parsed: { action: "fix" } },
    { name: "target", script: (p) => p.paths.push(join(dir, "c.mjs")), parsed: { action: "fix" } },
    { name: "replace", script: (p) => p.texts.push(WIZARD_CANCEL), parsed: { action: "replace", config: join(dir, "c.mjs"), target: dir, noReport: true } },
    { name: "mode", script: (p) => p.confirms.push(WIZARD_CANCEL), parsed: { action: "fix", config: join(dir, "c.mjs"), target: dir, noReport: true } },
  ];
  for (const scenario of cases) {
    const p = new FakePrompter();
    if (scenario.name === "target") {
      // config prompt first, then cancel the target prompt
      p.paths.push(join(dir, "c.mjs"));
      p.paths.push(WIZARD_CANCEL);
    } else {
      scenario.script(p);
    }
    const { code, runs } = await drive({
      parsed: invocation(scenario.parsed),
      prompter: p,
      cwd: dir,
      config: stubConfig({ targetRoot: dir }),
    });
    assert.equal(runs.length, 0, `${scenario.name} cancel never runs the action`);
    assert.equal(code, 0, `${scenario.name} cancel exits cleanly`);
    assert.equal(callsOf(p, "cancel").length, 1, `${scenario.name} cancel is reported`);
  }
});

test("a cancel at the post-run prompt returns the dry-run code without applying", async () => {
  const dir = tempDir();
  const p = new FakePrompter();
  p.confirms.push(false);
  p.selects.push(WIZARD_CANCEL);
  const { code, runs } = await drive({
    parsed: invocation({ action: "suppress", config: join(dir, "c.mjs"), target: dir, noReport: true }),
    prompter: p,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
    codes: [1],
  });
  assert.equal(runs.length, 1, "no apply run after a cancel");
  assert.equal(code, 1);
});

test("flags bypass every prompt", async () => {
  const dir = tempDir();
  const p = new FakePrompter();
  const { code, runs } = await drive({
    parsed: invocation({
      action: "suppress",
      config: join(dir, "c.mjs"),
      target: dir,
      mode: "apply",
      noReport: true,
    }),
    prompter: p,
    cwd: dir,
    config: stubConfig({ targetRoot: dir }),
  });

  assert.equal(p.calls.length, 0, "a fully-carried invocation prompts nothing, not even intro/outro");
  assert.equal(runs.length, 1);
  assert.equal(code, 0);
});

test("a non-TTY run never prompts", async () => {
  const dir = tempDir();
  write(dir, "pocket-comb.config.mjs", "export default [{ rules: {} }];\n");
  const io = fakeIo({ cwd: dir, tty: false });
  const exploding: Prompter = {
    intro: () => assert.fail("prompted on a non-TTY"),
    outro: () => assert.fail("prompted on a non-TTY"),
    cancel: () => assert.fail("prompted on a non-TTY"),
    select: async () => assert.fail("prompted on a non-TTY"),
    text: async () => assert.fail("prompted on a non-TTY"),
    confirm: async () => assert.fail("prompted on a non-TTY"),
    path: async () => assert.fail("prompted on a non-TTY"),
  };

  const code = await main(["replace"], io.io, { prompter: exploding });
  assert.equal(code, 2, "the missing pair is an operational error, never a question");
  assert.match(io.stderr(), /--from/);
});
