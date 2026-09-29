import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  configYaml,
  eslintConfig,
  exceptionYaml,
  NEXT_LINE_NO_CONSOLE_FP,
  NEXT_LINE_NO_DEBUGGER_FP,
  repo,
  cleanupRepos,
  PROTECTED_REGISTRY,
  PROTECTED_CONFIG,
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";
import { addDuration, daysBetween } from "../src/policy.js";
import { expiryRefusal } from "../src/wizard.js";
import type { ExceptionRecord, Policy } from "../src/types.js";

after(cleanupRepos);

const debtLine = "// eslint-disable-next-line no-console\n";

/**
 * A two-step repo with the gate on: ESLint governing `no-console`, a committed
 * config, and a clean baseline. The debt lands in the working tree afterwards
 * — the wizard is a working-tree surface, so its fixtures never stage.
 */
function wizardRepo(opts: { config?: string } = {}): FixtureRepo {
  const r = repo();
  r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
  if (opts.config !== undefined) r.write(PROTECTED_CONFIG, opts.config);
  r.write("app.js", "export const a = 1;\n");
  r.commit("base");
  return r;
}

/** One new governed suppression in the working tree, directive on line 2. */
function singleDebt(r: FixtureRepo): void {
  r.write("app.js", `export const a = 1;\n${debtLine}console.log(1);\n`);
}

/**
 * A repo whose working tree turns one governed rule off in the flat config. The
 * baseline governs `no-console` and `no-debugger` at error; the head turns
 * `no-console` off and leaves `no-debugger` alone. A `config-off` reconciles to
 * `new` like any unpaired suppression and sits at line 1 of the config file, so
 * `--from eslint.config.mjs:1` reaches it directly.
 */
function configOffRepo(): FixtureRepo {
  const r = repo();
  r.write("eslint.config.mjs", eslintConfig({ "no-console": "error", "no-debugger": "error" }));
  r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
  r.write("app.js", "export const a = 1;\n");
  r.commit("base");
  r.write("eslint.config.mjs", eslintConfig({ "no-console": "off", "no-debugger": "error" }));
  return r;
}

/**
 * One new governed `no-debugger` suppression, directive on line 2. Deliberately
 * off the rule the config turned off: a directive for a `config-off` rule is
 * unused rather than debt, so debt on `no-console` would prove nothing here.
 */
function debuggerDebt(r: FixtureRepo): void {
  r.write("app.js", "export const a = 1;\n// eslint-disable-next-line no-debugger\ndebugger;\n");
}

/** Two same-file twins (one pool), directives on lines 2 and 4. */
function twinDebt(r: FixtureRepo): void {
  r.write("app.js", `export const a = 1;\n${debtLine}console.log(1);\n${debtLine}console.log(2);\n`);
}

/**
 * The dates this run's transcript was built from, read as close to the run as
 * possible: the subprocess resolves its own `now`, and the midnight between
 * compute and run is the one flake this suite can otherwise grow.
 */
function dates(): { today: string; default: string; max: string; custom: string; beyond: string } {
  const today = new Date().toISOString().slice(0, 10);
  return {
    today,
    default: addDuration(today, "30d"),
    max: addDuration(today, "3mo"),
    custom: addDuration(today, "45d"),
    beyond: addDuration(today, "6mo"),
  };
}

/** A frozen transcript: the exact bytes of stdout, one string per line. */
function t(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

const bootMenu = [
  "reading the working tree's new debt…",
  "this session is for:",
  "  1) new debt from this change",
  "  2) renew an expiring record",
  "choose — 1 (new debt) or 2 (renew):",
];

const nextSteps = [
  "",
  "Next steps",
  "  1. land the record in its own PR — an approver reviews and merges it",
  "  2. once merged, land the code change that adds the suppression",
];

/** A renewal's landing guidance: the protected track, in either landing mode. */
const renewalSteps = [
  "",
  "Next steps",
  "  1. the renewal updates the existing record's expiry in place",
  "  2. submit it in a PR — an approver reviews and merges it",
];

function pickSingle(): string[] {
  return [
    "select which to record (number — 1):",
    "❯ 1",
    "◉ selected  app.js:2  no-console  (next-line)",
  ];
}

function pickTwins(): string[] {
  return [
    "select which to record (numbers — e.g. 1, or 1,2):",
    "❯ 1,2",
    "◉ selected  app.js:2  no-console  (next-line)",
    "◉ selected  app.js:4  no-console  (next-line)",
  ];
}

function runWizard(r: FixtureRepo, script: string) {
  return r.runCli(["exception", "add"], { json: false, input: script });
}

describe("the wizard: pocket-zipper exception add", () => {
  it("writes a machine-authored record for new debt, two-step posture", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const d = dates();
    const res = runWizard(
      r,
      "1\n1\nNeeded for the debug toolbar.\nhttps://github.com/org/repo/issues/123\n\ny\n\n",
    );
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 1",
        "→ new debt",
        "  1) app.js:2  no-console  (next-line, new)",
        ...pickSingle(),
        "reason for the exception (required):",
        "❯ Needed for the debug toolbar.",
        "reference (issue / PR / ticket link) — optional; Enter to skip:",
        "❯ https://github.com/org/repo/issues/123",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${d.default}`,
        "    reason:    Needed for the debug toolbar.",
        "    reference: https://github.com/org/repo/issues/123",
        "write the exception? [y/N]",
        "❯ y",
        `✎ exception record written to ${PROTECTED_REGISTRY}`,
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    // Match fields are machine-authored, never hand-typed: the known
    // fingerprint, the ESLint rule, the directive form, the file scope, and the
    // capture-time line all arrive from the inventory.
    assert.equal(
      r.read(PROTECTED_REGISTRY),
      t(
        "- rule: no-console",
        "  suppression_type: next-line",
        `  fingerprint: ${NEXT_LINE_NO_CONSOLE_FP}`,
        "  file: app.js",
        "  type: temporary",
        "  reason: Needed for the debug toolbar.",
        "  reference: https://github.com/org/repo/issues/123",
        `  expires: ${d.default}`,
        "  line: 2",
      ),
    );
    // The written registry is one the shared validator blesses: the wizard
    // refuses to write a defect-producing record, so the registry it leaves
    // behind lints clean.
    const lint = r.runCli(["validate"], { json: false });
    assert.equal(lint.status, 0);
  });

  it("earns N records for N twins with one shared interview", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    twinDebt(r);
    const d = dates();
    const res = runWizard(r, "1\n1,2\n\nOne reason covers both twins.\n\n\ny\n\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 1",
        "→ new debt",
        "  1) app.js:2  no-console  (next-line, new)",
        "  2) app.js:4  no-console  (next-line, new)",
        ...pickTwins(),
        "Do these 2 exceptions all share one reason? [Y/n]",
        "reason for the exception (required):",
        "❯ One reason covers both twins.",
        "reference (issue / PR / ticket link) — optional; Enter to skip:",
        "reference (issue / PR / ticket link) — optional: Skipped",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${d.default}`,
        "    reason:    One reason covers both twins.",
        `  • no-console @ app.js:4 — next-line (new) — expires ${d.default}`,
        "write the exception? [y/N]",
        "❯ y",
        `✎ exception records written to ${PROTECTED_REGISTRY}`,
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    // One record per suppression, distinguished only by their capture-time
    // line; the skipped reference is omitted, not written empty.
    assert.equal(
      r.read(PROTECTED_REGISTRY),
      t(
        "- rule: no-console",
        "  suppression_type: next-line",
        `  fingerprint: ${NEXT_LINE_NO_CONSOLE_FP}`,
        "  file: app.js",
        "  type: temporary",
        "  reason: One reason covers both twins.",
        `  expires: ${d.default}`,
        "  line: 2",
        "- rule: no-console",
        "  suppression_type: next-line",
        `  fingerprint: ${NEXT_LINE_NO_CONSOLE_FP}`,
        "  file: app.js",
        "  type: temporary",
        "  reason: One reason covers both twins.",
        `  expires: ${d.default}`,
        "  line: 4",
      ),
    );
  });

  it("interviews per record when the twins do not share one reason", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    twinDebt(r);
    const d = dates();
    const res = runWizard(
      r,
      "1\n1,2\nn\nReason for the first.\nhttps://github.com/org/repo/issues/1\nReason for the second.\n\n\ny\n\n",
    );
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 1",
        "→ new debt",
        "  1) app.js:2  no-console  (next-line, new)",
        "  2) app.js:4  no-console  (next-line, new)",
        ...pickTwins(),
        "Do these 2 exceptions all share one reason? [Y/n]",
        "❯ n",
        "reason for record 1 of 2 — app.js:2:",
        "❯ Reason for the first.",
        "reference (issue / PR / ticket link) for record 1 of 2 — app.js:2 — optional; Enter to skip:",
        "❯ https://github.com/org/repo/issues/1",
        "reason for record 2 of 2 — app.js:4:",
        "❯ Reason for the second.",
        "reference (issue / PR / ticket link) for record 2 of 2 — app.js:4 — optional; Enter to skip:",
        "reference (issue / PR / ticket link) for record 2 of 2 — app.js:4 — optional: Skipped",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${d.default}`,
        "    reason:    Reason for the first.",
        "    reference: https://github.com/org/repo/issues/1",
        `  • no-console @ app.js:4 — next-line (new) — expires ${d.default}`,
        "    reason:    Reason for the second.",
        "write the exception? [y/N]",
        "❯ y",
        `✎ exception records written to ${PROTECTED_REGISTRY}`,
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    assert.match(r.read(PROTECTED_REGISTRY), /reason: Reason for the first\./);
    assert.match(r.read(PROTECTED_REGISTRY), /reason: Reason for the second\./);
  });

  it("declines at the write prompt and leaves the registry unwritten", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const d = dates();
    const res = runWizard(r, "1\n1\nReason kept to myself.\n\n\n\n\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 1",
        "→ new debt",
        "  1) app.js:2  no-console  (next-line, new)",
        ...pickSingle(),
        "reason for the exception (required):",
        "❯ Reason kept to myself.",
        "reference (issue / PR / ticket link) — optional; Enter to skip:",
        "reference (issue / PR / ticket link) — optional: Skipped",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${d.default}`,
        "    reason:    Reason kept to myself.",
        "write the exception? [y/N]",
        "nothing written — the proposed record stays unwritten.",
        "run another session? [y/N]",
      ),
    );
    assert.ok(!existsSync(join(r.dir, PROTECTED_REGISTRY)));
  });

  it("refuses a past date distinctly, then takes a custom date within the max", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const d = dates();
    const res = runWizard(
      r,
      `1\n1\nNeeded.\n\nn\nx\nn\n31/12/2026\n2026-13-45\n2000-01-01\nn\n${d.custom}\ny\n\n`,
    );
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 1",
        "→ new debt",
        "  1) app.js:2  no-console  (next-line, new)",
        ...pickSingle(),
        "reason for the exception (required):",
        "❯ Needed.",
        "reference (issue / PR / ticket link) — optional; Enter to skip:",
        "reference (issue / PR / ticket link) — optional: Skipped",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        "❯ n",
        "make this a permanent exception? [y/N]",
        "❯ x",
        "type y for a permanent exception (an approver is required), or n to pick a date",
        "make this a permanent exception? [y/N]",
        "❯ n",
        `new expiry — YYYY-MM-DD, no later than ${d.max}:`,
        "❯ 31/12/2026",
        `type a date as YYYY-MM-DD — e.g. ${d.default}, up to ${d.max}`,
        `new expiry — YYYY-MM-DD, no later than ${d.max}:`,
        "❯ 2026-13-45",
        `not a real date — use YYYY-MM-DD (e.g. ${d.default}), up to ${d.max}`,
        `new expiry — YYYY-MM-DD, no later than ${d.max}:`,
        "❯ 2000-01-01",
        `✘ 2000-01-01 is in the past. Choose a future date no later than ${d.max}, or make it permanent.`,
        "make this a permanent exception? [y/N]",
        "❯ n",
        `new expiry — YYYY-MM-DD, no later than ${d.max}:`,
        `❯ ${d.custom}`,
        `expiry: change → ${d.custom}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${d.custom}`,
        "    reason:    Needed.",
        "write the exception? [y/N]",
        "❯ y",
        `✎ exception record written to ${PROTECTED_REGISTRY}`,
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    assert.match(r.read(PROTECTED_REGISTRY), new RegExp(`expires: ${d.custom}`));
  });

  it("refuses a beyond-max date, then escapes to permanent through the approver note", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const d = dates();
    const res = runWizard(r, `1\n1\nNeeded.\n\nn\nn\n${d.beyond}\ny\ny\n\n`);
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 1",
        "→ new debt",
        "  1) app.js:2  no-console  (next-line, new)",
        ...pickSingle(),
        "reason for the exception (required):",
        "❯ Needed.",
        "reference (issue / PR / ticket link) — optional; Enter to skip:",
        "reference (issue / PR / ticket link) — optional: Skipped",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        "❯ n",
        "make this a permanent exception? [y/N]",
        "❯ n",
        `new expiry — YYYY-MM-DD, no later than ${d.max}:`,
        `❯ ${d.beyond}`,
        `✘ ${d.beyond} is later than the max (${d.max}). Choose a date no later than ${d.max}, or make it permanent.`,
        "make this a permanent exception? [y/N]",
        "❯ y",
        "permanent exceptions require an approver.",
        "expiry: permanent — no expires",
        "Review — the record(s) to write:",
        "  • no-console @ app.js:2 — next-line (new) — permanent",
        "    reason:    Needed.",
        "write the exception? [y/N]",
        "❯ y",
        `✎ exception record written to ${PROTECTED_REGISTRY}`,
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    assert.equal(
      r.read(PROTECTED_REGISTRY),
      t(
        "- rule: no-console",
        "  suppression_type: next-line",
        `  fingerprint: ${NEXT_LINE_NO_CONSOLE_FP}`,
        "  file: app.js",
        "  type: permanent",
        "  reason: Needed.",
        "  line: 2",
      ),
    );
    const lint = r.runCli(["validate"], { json: false });
    assert.equal(lint.status, 0);
  });

  it("runs another session against the registry the first one wrote", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const d = dates();
    const res = runWizard(r, "1\n1\nFirst reason.\n\n\ny\ny\n1\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 1",
        "→ new debt",
        "  1) app.js:2  no-console  (next-line, new)",
        ...pickSingle(),
        "reason for the exception (required):",
        "❯ First reason.",
        "reference (issue / PR / ticket link) — optional; Enter to skip:",
        "reference (issue / PR / ticket link) — optional: Skipped",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${d.default}`,
        "    reason:    First reason.",
        "write the exception? [y/N]",
        "❯ y",
        `✎ exception record written to ${PROTECTED_REGISTRY}`,
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
        "❯ y",
        ...bootMenu,
        "❯ 1",
        "→ new debt",
        "no new debt from this change requires an exception.",
      ),
    );
    // The record the first session wrote covers the suppression, so the
    // restarted inventory — the same read the gate makes — lists nothing.
    assert.match(r.read(PROTECTED_REGISTRY), /reason: First reason\./);
  });

  it("reports itself blocked without a config and hands off to the authorizers", () => {
    const r = wizardRepo();
    singleDebt(r);
    const res = runWizard(r, "1\n");
    assert.equal(res.status, 1);
    assert.equal(
      res.stdout,
      t(
        `Pocket Zipper isn't configured in this repo (no ${PROTECTED_CONFIG})`,
        "nothing can be written here — config is set up by the repo's authorizers at install time, not by this flow",
      ),
    );
    assert.ok(!existsSync(join(r.dir, PROTECTED_REGISTRY)));
  });

  it("refuses every unknown answer with a terse restatement of the options", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const d = dates();
    const res = runWizard(r, "x\n1\n9\n1\n\nNeeded.\n\nmaybe\n\nz\ny\nz\n\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ x",
        "type 1 (new debt) or 2 (renew)",
        "choose — 1 (new debt) or 2 (renew):",
        "❯ 1",
        "→ new debt",
        "  1) app.js:2  no-console  (next-line, new)",
        "select which to record (number — 1):",
        "❯ 9",
        "pick 1 — it is the only new debt",
        "select which to record (number — 1):",
        "❯ 1",
        "◉ selected  app.js:2  no-console  (next-line)",
        "reason for the exception (required):",
        "the reason is required — type it (Enter has no meaning here)",
        "reason for the exception (required):",
        "❯ Needed.",
        "reference (issue / PR / ticket link) — optional; Enter to skip:",
        "reference (issue / PR / ticket link) — optional: Skipped",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        "❯ maybe",
        "type y to accept the default, or n to set your own date / make it permanent",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${d.default}`,
        "    reason:    Needed.",
        "write the exception? [y/N]",
        "❯ z",
        "type y to write the exception, or press Enter to leave it unwritten",
        "write the exception? [y/N]",
        "❯ y",
        `✎ exception record written to ${PROTECTED_REGISTRY}`,
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
        "❯ z",
        "type y to run another session, or press Enter to finish",
        "run another session? [y/N]",
      ),
    );
  });

  it("prints no landing steps where the baseline posture is combined", () => {
    const r = wizardRepo({
      config: configYaml({ enabled: true, allowSameChangeExceptions: true, host: "github" }),
    });
    singleDebt(r);
    const d = dates();
    const res = runWizard(r, "1\n1\nNeeded.\n\n\ny\n\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 1",
        "→ new debt",
        "  1) app.js:2  no-console  (next-line, new)",
        ...pickSingle(),
        "reason for the exception (required):",
        "❯ Needed.",
        "reference (issue / PR / ticket link) — optional; Enter to skip:",
        "reference (issue / PR / ticket link) — optional: Skipped",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${d.default}`,
        "    reason:    Needed.",
        "write the exception? [y/N]",
        "❯ y",
        `✎ exception record written to ${PROTECTED_REGISTRY}`,
        "it takes effect only once the change is approved and merged.",
        "run another session? [y/N]",
      ),
    );
  });

  it("leaves an input-exhausted session unwritten and non-zero", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const res = runWizard(r, "");
    assert.equal(res.status, 1);
    assert.equal(res.stdout, t(...bootMenu));
    assert.ok(!existsSync(join(r.dir, PROTECTED_REGISTRY)));
  });

  it("says the gate is disabled and offers nothing to except", () => {
    const r = wizardRepo({ config: configYaml({ enabled: false }) });
    singleDebt(r);
    const res = runWizard(r, "1\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t("the gate is disabled in this repo's policy — no debt requires an exception."),
    );
  });

  it("refuses to run where the working-tree registry is defective", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    r.write(
      PROTECTED_REGISTRY,
      [
        "- rule: no-console",
        "  suppression_type: next-line",
        `  fingerprint: ${NEXT_LINE_NO_CONSOLE_FP}`,
        "  file: app.js",
        "  type: permanent",
        "  reason: needed",
        '  owner: "@team"',
        "",
      ].join("\n"),
    );
    const res = runWizard(r, "1\n");
    assert.equal(res.status, 2);
    assert.match(res.stdout, /UNKNOWN_FIELD/);
    assert.match(
      res.stdout,
      /unknown field 'owner' — removed from the registry format; delete this line/,
    );
    // The defective registry is left exactly as it was found.
    assert.match(r.read(PROTECTED_REGISTRY), /owner: "@team"/);
  });

  it("takes no interactive session beyond the last prompt of a written record", () => {
    // Input ends right after the final Enter: the session is complete, not
    // abandoned, and the write's exit code stands.
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const res = runWizard(r, "1\n1\nNeeded.\n\n\ny\n");
    assert.equal(res.status, 0);
    assert.match(r.read(PROTECTED_REGISTRY), /reason: Needed\./);
  });

  it("reads debt in a file the index dropped but the disk keeps", () => {
    // The `git rm --cached` shape: HEAD carries the file, the index does not,
    // and the disk still does. The diff alone would call it deleted — the
    // wizard reads the tree, so the debt on disk is still offered.
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    r.git(["rm", "--cached", "app.js"]);
    const d = dates();
    const res = runWizard(r, "1\n1\nNeeded.\n\n\ny\n\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 1",
        "→ new debt",
        "  1) app.js:2  no-console  (next-line, new)",
        ...pickSingle(),
        "reason for the exception (required):",
        "❯ Needed.",
        "reference (issue / PR / ticket link) — optional; Enter to skip:",
        "reference (issue / PR / ticket link) — optional: Skipped",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${d.default}`,
        "    reason:    Needed.",
        "write the exception? [y/N]",
        "❯ y",
        `✎ exception record written to ${PROTECTED_REGISTRY}`,
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    assert.match(r.read(PROTECTED_REGISTRY), /line: 2/);
  });
});

/** The date N days back: a duration literal only counts forward, expiry can only be past. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** A repo whose working tree holds one debt and one temporary record covering it. */
function renewableRepo(): { repo: FixtureRepo; registry: string; expires: string; today: string } {
  const r = wizardRepo({ config: configYaml({ enabled: true }) });
  singleDebt(r);
  const today = new Date().toISOString().slice(0, 10);
  const expires = addDuration(today, "10d");
  const registry = exceptionYaml({
    rule: "no-console",
    suppressionType: "next-line",
    fingerprint: NEXT_LINE_NO_CONSOLE_FP,
    file: "app.js",
    expires,
    line: 2,
  });
  r.write(PROTECTED_REGISTRY, registry);
  return { repo: r, registry, expires, today };
}

describe("the wizard: the renew branch", () => {
  it("edits the chosen record's expires in place — never an append", () => {
    const { repo: r, registry, expires } = renewableRepo();
    const d = dates();
    const res = runWizard(r, "2\n1\n\ny\n\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 2",
        "→ renewal — expiring record:",
        `  1) no-console @ app.js:2 — expires ${expires} (in 10d)`,
        "select which to renew (number — 1):",
        "❯ 1",
        "⤷ renewing no-console @ app.js:2",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `new expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (renewal) — expires ${d.default}`,
        "    reason:    needed",
        '    reference: #1',
        "write the exception? [y/N]",
        "❯ y",
        `✎ the existing record's expiry is now ${d.default}`,
        "it takes effect only once the change is approved and merged.",
        ...renewalSteps,
        "run another session? [y/N]",
      ),
    );
    // One record, dated in place: the pool keeps its size, so the hygiene check
    // that accuses a renewal-by-append has nothing to accuse.
    assert.equal(r.read(PROTECTED_REGISTRY), registry.replace(expires, d.default));
    const lint = r.runCli(["validate"], { json: false });
    assert.equal(lint.status, 0);
    assert.doesNotMatch(lint.stdout, /RENEWAL_BY_APPEND/);
    assert.doesNotMatch(lint.stdout, /POOL_COUNTS/);
  });

  it("refuses a beyond-max renewal, then escapes to permanent through the approver note", () => {
    const { repo: r, registry, expires } = renewableRepo();
    const d = dates();
    const res = runWizard(r, `2\n1\nn\nn\n${d.beyond}\ny\ny\n\n`);
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 2",
        "→ renewal — expiring record:",
        `  1) no-console @ app.js:2 — expires ${expires} (in 10d)`,
        "select which to renew (number — 1):",
        "❯ 1",
        "⤷ renewing no-console @ app.js:2",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        "❯ n",
        "make this a permanent exception? [y/N]",
        "❯ n",
        `new expiry — YYYY-MM-DD, no later than ${d.max}:`,
        `❯ ${d.beyond}`,
        `✘ ${d.beyond} is later than the max (${d.max}). Choose a date no later than ${d.max}, or make it permanent.`,
        "make this a permanent exception? [y/N]",
        "❯ y",
        "permanent exceptions require an approver.",
        "expiry: permanent — no expires",
        "Review — the record(s) to write:",
        "  • no-console @ app.js:2 — next-line (renewal) — permanent",
        "    reason:    needed",
        '    reference: #1',
        "write the exception? [y/N]",
        "❯ y",
        "✎ the existing record's expiry is now permanent",
        "it takes effect only once the change is approved and merged.",
        ...renewalSteps,
        "run another session? [y/N]",
      ),
    );
    // Permanent is a field edit too: the type rewritten, the date gone with its
    // line, and still exactly one record in the file.
    assert.equal(
      r.read(PROTECTED_REGISTRY),
      registry.replace("  type: temporary\n", "  type: permanent\n").replace(`  expires: ${expires}\n`, ""),
    );
    assert.equal(r.runCli(["validate"], { json: false }).status, 0);
  });

  it("lists every temporary record, and nothing that carries no date", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    const today = new Date().toISOString().slice(0, 10);
    const soon = addDuration(today, "3d");
    const later = addDuration(today, "2mo");
    const gone = daysAgo(5);
    const record = (expires: string) =>
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires,
      });
    r.write(
      PROTECTED_REGISTRY,
      record(soon) +
        record(later) +
        record(gone) +
        exceptionYaml({
          rule: "no-debugger",
          suppressionType: "block",
          fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
          file: "tools/build.js",
          type: "permanent",
        }),
    );
    const d = dates();
    const res = runWizard(r, "2\n2\n\ny\n\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 2",
        "→ renewal — expiring record:",
        `  1) no-console @ app.js — expires ${soon} (in 3d)`,
        `  2) no-console @ app.js — expires ${later} (in ${daysBetween(today, later)}d)`,
        `  3) no-console @ app.js — expires ${gone} (expired 5d ago)`,
        "select which to renew (number — 1 to 3):",
        "❯ 2",
        "⤷ renewing no-console @ app.js",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `new expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js — next-line (renewal) — expires ${d.default}`,
        "    reason:    needed",
        '    reference: #1',
        "write the exception? [y/N]",
        "❯ y",
        `✎ the existing record's expiry is now ${d.default}`,
        "it takes effect only once the change is approved and merged.",
        ...renewalSteps,
        "run another session? [y/N]",
      ),
    );
    // The permanent record is untouched, the records beside the renewed one keep
    // the dates they had, and the file still holds exactly four records.
    const written = r.read(PROTECTED_REGISTRY);
    assert.equal(written.split("- rule:").length - 1, 4);
    assert.ok(written.includes(`expires: ${soon}`));
    assert.ok(written.includes(`expires: ${gone}`));
    assert.ok(written.includes("type: permanent"));
    assert.equal(written.split(`expires: ${d.default}`).length - 1, 1);
    assert.ok(!written.includes(later));
  });

  it("keeps a renewal on the protected track where combined landing is on", () => {
    // A renewal moves a horizon every later evaluation judges by, so the
    // approval that covers the record it edits does not cover the renewal: the
    // two-step guidance prints in both landing modes.
    const r = wizardRepo({
      config: configYaml({ enabled: true, allowSameChangeExceptions: true, host: "github" }),
    });
    singleDebt(r);
    const today = new Date().toISOString().slice(0, 10);
    const expires = addDuration(today, "10d");
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires,
        line: 2,
      }),
    );
    const d = dates();
    const res = runWizard(r, "2\n1\n\ny\n\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 2",
        "→ renewal — expiring record:",
        `  1) no-console @ app.js:2 — expires ${expires} (in 10d)`,
        "select which to renew (number — 1):",
        "❯ 1",
        "⤷ renewing no-console @ app.js:2",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `new expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (renewal) — expires ${d.default}`,
        "    reason:    needed",
        '    reference: #1',
        "write the exception? [y/N]",
        "❯ y",
        `✎ the existing record's expiry is now ${d.default}`,
        "it takes effect only once the change is approved and merged.",
        ...renewalSteps,
        "run another session? [y/N]",
      ),
    );
  });

  it("refuses a pick outside the list with a terse restatement of the options", () => {
    const { repo: r, expires } = renewableRepo();
    const d = dates();
    const res = runWizard(r, "2\n7\n1\n\ny\n\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 2",
        "→ renewal — expiring record:",
        `  1) no-console @ app.js:2 — expires ${expires} (in 10d)`,
        "select which to renew (number — 1):",
        "❯ 7",
        "pick 1 — it is the only expiring record",
        "select which to renew (number — 1):",
        "❯ 1",
        "⤷ renewing no-console @ app.js:2",
        `a default expiry of ${d.default} (30 days from today) is set — accept it? [Y/n]`,
        `new expiry: ${d.default}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (renewal) — expires ${d.default}`,
        "    reason:    needed",
        '    reference: #1',
        "write the exception? [y/N]",
        "❯ y",
        `✎ the existing record's expiry is now ${d.default}`,
        "it takes effect only once the change is approved and merged.",
        ...renewalSteps,
        "run another session? [y/N]",
      ),
    );
  });

  it("leaves the record alone when the renewal is declined at the write prompt", () => {
    const { repo: r, registry } = renewableRepo();
    const res = runWizard(r, "2\n1\n\n\n\n");
    assert.equal(res.status, 0);
    assert.match(
      res.stdout,
      /nothing written — the proposed record stays unwritten\.\nrun another session\? \[y\/N\]\n$/,
    );
    assert.equal(r.read(PROTECTED_REGISTRY), registry);
  });

  it("says so when the registry holds nothing a renewal could edit", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const res = runWizard(r, "2\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 2",
        "no temporary record in this registry to renew — a renewal edits an existing record's expires in place.",
      ),
    );
  });
});

// The net the ladder consults, exercised directly: the date prompt refuses an
// out-of-policy date before a decision can reach it, so this is the only
// reproducible way to see the shared refusal the authoring surface writes under.
describe("the expiry-policy net every write is held to", () => {
  const NOW = new Date("2026-09-28T12:00:00Z");
  const POLICY: Policy = {
    enabled: true,
    governedRules: null,
    exceptions: { defaultExpiry: "30d", maxExpiry: "3mo" },
    allowSameChangeExceptions: false,
    host: null,
  };
  const record = (init: { type: "temporary"; expires: string } | { type: "permanent" }): ExceptionRecord => ({
    rule: "no-console",
    suppression_type: "next-line",
    fingerprint: NEXT_LINE_NO_CONSOLE_FP,
    file: "app.js",
    reason: "needed",
    ...init,
  });

  it("refuses a newly written date past the baseline max, in the gate's words", () => {
    const baseline = [record({ type: "temporary", expires: "2026-10-01" })];
    assert.equal(
      expiryRefusal({
        baseline,
        head: [record({ type: "temporary", expires: "2027-01-15" })],
        policy: POLICY,
        now: NOW,
      }),
      "✘ EXPIRY_POLICY — newly written expires 2027-01-15 for no-console in app.js runs past the baseline 3mo maximum (on or before 2026-12-28)",
    );
  });

  it("lets a renewal through when the date it writes is inside the max", () => {
    const baseline = [record({ type: "temporary", expires: "2026-10-01" })];
    assert.equal(
      expiryRefusal({
        baseline,
        head: [record({ type: "temporary", expires: "2026-11-01" })],
        policy: POLICY,
        now: NOW,
      }),
      null,
    );
  });

  it("leaves a permanent orthogonal to the maximum, as the gate does", () => {
    const baseline = [record({ type: "temporary", expires: "2026-10-01" })];
    assert.equal(
      expiryRefusal({
        baseline,
        head: [record({ type: "permanent" })],
        policy: POLICY,
        now: NOW,
      }),
      null,
    );
  });
});

describe("the wizard: non-interactive flags", () => {
  it("writes the record a script or agent asks for, no prompts, same output", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const d = dates();
    const res = r.runCli(
      [
        "exception",
        "add",
        "--from",
        "app.js:2",
        "--reason",
        "Needed for the debug toolbar.",
        "--reference",
        "https://github.com/org/repo/issues/123",
      ],
      { json: false },
    );
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${d.default}`,
        "    reason:    Needed for the debug toolbar.",
        "    reference: https://github.com/org/repo/issues/123",
        `✎ exception record written to ${PROTECTED_REGISTRY}`,
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
      ),
    );
    assert.match(r.read(PROTECTED_REGISTRY), /line: 2/);
  });

  it("refuses a non-interactive session without a reason", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const res = r.runCli(["exception", "add", "--from", "app.js:2"], { json: false });
    assert.equal(res.status, 1);
    assert.equal(res.stderr, "the reason is required — pass it with --reason <text>\n");
    assert.ok(!existsSync(join(r.dir, PROTECTED_REGISTRY)));
  });

  it("refuses a --from that selects no new debt", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const res = r.runCli(
      ["exception", "add", "--from", "app.js:9", "--reason", "Needed."],
      { json: false },
    );
    assert.equal(res.status, 1);
    assert.equal(res.stderr, "no new debt at app.js:9\n");
  });

  it("offers no new debt at all when the only new thing is a config-off", () => {
    // A new config-off reconciles to `new`, exactly as a new directive does, and
    // sits at line 1 of the config file. It is a policy change rather than debt:
    // no record may name a `config-off`, so authoring one here would write a
    // record the validator refuses on the next read.
    const r = configOffRepo();
    const res = r.runCli(
      ["exception", "add", "--from", "eslint.config.mjs:1", "--reason", "Needed."],
      { json: false },
    );
    assert.equal(res.status, 1);
    assert.equal(res.stderr, "no new debt at eslint.config.mjs:1\n");
    assert.ok(!existsSync(join(r.dir, PROTECTED_REGISTRY)));
  });

  it("lists only the directive when a config-off lands beside new debt", () => {
    const r = configOffRepo();
    debuggerDebt(r);
    const res = runWizard(r, "1\n");
    // The numbered list is the whole offer, and it must carry the directive and
    // not the config-off. A config-off in it would be a selection that can only
    // end in a record nothing can match. Matched on the config file's own name:
    // the list renders it as `eslint.config.mjs:1  no-console  (config-off, new)`.
    assert.match(res.stdout, /1\) app\.js:\d+\s+no-debugger\s+\(next-line, new\)/);
    assert.ok(!res.stdout.includes("eslint.config.mjs"), res.stdout);
  });

  it("refuses a --from that cannot pick between two suppressions on one line", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error", "no-debugger": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    // One directive naming two governed rules: two logical suppressions, one
    // line — a selector with no rule half cannot pick between them.
    r.write(
      "app.js",
      "export const a = 1;\n// eslint-disable-next-line no-console, no-debugger\nconsole.log(1); debugger;\n",
    );
    const res = r.runCli(
      ["exception", "add", "--from", "app.js:2", "--reason", "Needed."],
      { json: false },
    );
    assert.equal(res.status, 1);
    assert.equal(
      res.stderr,
      "2 suppressions sit at app.js:2 — --from cannot choose between them; record them in an interactive session\n",
    );
  });
});

describe("the wizard: CLI surface", () => {
  it("advertises itself in the usage text, so it is discoverable without a README", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    const res = r.runCli(["--help"], { json: false });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^ {2}pocket-zipper exception add/m);
  });

  it("takes only its own three flags, and they travel together", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    for (const args of [
      ["exception", "add", "--verbose"],
      ["exception", "add", "--json", "out.json"],
      ["exception", "add", "--reason", "Needed."],
      ["exception", "add", "--reference", "#1"],
      ["exception", "add", "--from"],
    ]) {
      const res = r.runCli(args, { json: false });
      assert.equal(res.status, 2, args.join(" "));
      assert.match(res.stderr, /unknown argument|require/, args.join(" "));
    }
    assert.ok(!existsSync(join(r.dir, PROTECTED_REGISTRY)));
  });
});
