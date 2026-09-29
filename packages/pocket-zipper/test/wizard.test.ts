import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createRepo,
  configYaml,
  eslintConfig,
  NEXT_LINE_NO_CONSOLE_FP,
  type FixtureRepo,
} from "./harness.js";
import { addDuration } from "../src/policy.js";

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

function repo(): FixtureRepo {
  const r = createRepo();
  repos.push(r);
  return r;
}

const debtLine = "// eslint-disable-next-line no-console\n";

/**
 * A two-step repo with the gate on: ESLint governing `no-console`, a committed
 * config, and a clean baseline. The debt lands in the working tree afterwards
 * — the wizard is a working-tree surface, so its fixtures never stage.
 */
function wizardRepo(opts: { config?: string } = {}): FixtureRepo {
  const r = repo();
  r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
  if (opts.config !== undefined) r.write(".pocket-zipper/config.yml", opts.config);
  r.write("app.js", "export const a = 1;\n");
  r.commit("base");
  return r;
}

/** One new governed suppression in the working tree, directive on line 2. */
function singleDebt(r: FixtureRepo): void {
  r.write("app.js", `export const a = 1;\n${debtLine}console.log(1);\n`);
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
        "✎ exception record written to .pocket-zipper/exceptions.yml",
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    // Match fields are machine-authored, never hand-typed: the known
    // fingerprint, the ESLint rule, the directive form, the file scope, and the
    // capture-time line all arrive from the inventory.
    assert.equal(
      r.read(".pocket-zipper/exceptions.yml"),
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
        "✎ exception records written to .pocket-zipper/exceptions.yml",
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    // One record per suppression, distinguished only by their capture-time
    // line; the skipped reference is omitted, not written empty.
    assert.equal(
      r.read(".pocket-zipper/exceptions.yml"),
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
        "✎ exception records written to .pocket-zipper/exceptions.yml",
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    assert.match(r.read(".pocket-zipper/exceptions.yml"), /reason: Reason for the first\./);
    assert.match(r.read(".pocket-zipper/exceptions.yml"), /reason: Reason for the second\./);
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
    assert.ok(!existsSync(join(r.dir, ".pocket-zipper/exceptions.yml")));
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
        "✎ exception record written to .pocket-zipper/exceptions.yml",
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    assert.match(r.read(".pocket-zipper/exceptions.yml"), new RegExp(`expires: ${d.custom}`));
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
        "✎ exception record written to .pocket-zipper/exceptions.yml",
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    assert.equal(
      r.read(".pocket-zipper/exceptions.yml"),
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
        "✎ exception record written to .pocket-zipper/exceptions.yml",
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
    assert.match(r.read(".pocket-zipper/exceptions.yml"), /reason: First reason\./);
  });

  it("reports itself blocked without a config and hands off to the authorizers", () => {
    const r = wizardRepo();
    singleDebt(r);
    const res = runWizard(r, "1\n");
    assert.equal(res.status, 1);
    assert.equal(
      res.stdout,
      t(
        "Pocket Zipper isn't configured in this repo (no .pocket-zipper/config.yml)",
        "nothing can be written here — config is set up by the repo's authorizers at install time, not by this flow",
      ),
    );
    assert.ok(!existsSync(join(r.dir, ".pocket-zipper/exceptions.yml")));
  });

  it("refuses every unknown answer with a terse restatement of the options", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const d = dates();
    const res = runWizard(r, "2\nx\n1\n9\n1\n\nNeeded.\n\nmaybe\n\nz\ny\nz\n\n");
    assert.equal(res.status, 0);
    assert.equal(
      res.stdout,
      t(
        ...bootMenu,
        "❯ 2",
        "renew is not available yet",
        "choose — 1 (new debt) or 2 (renew):",
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
        "✎ exception record written to .pocket-zipper/exceptions.yml",
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
        "✎ exception record written to .pocket-zipper/exceptions.yml",
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
    assert.ok(!existsSync(join(r.dir, ".pocket-zipper/exceptions.yml")));
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
      ".pocket-zipper/exceptions.yml",
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
    assert.match(r.read(".pocket-zipper/exceptions.yml"), /owner: "@team"/);
  });

  it("takes no interactive session beyond the last prompt of a written record", () => {
    // Input ends right after the final Enter: the session is complete, not
    // abandoned, and the write's exit code stands.
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const res = runWizard(r, "1\n1\nNeeded.\n\n\ny\n");
    assert.equal(res.status, 0);
    assert.match(r.read(".pocket-zipper/exceptions.yml"), /reason: Needed\./);
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
        "✎ exception record written to .pocket-zipper/exceptions.yml",
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
        "run another session? [y/N]",
      ),
    );
    assert.match(r.read(".pocket-zipper/exceptions.yml"), /line: 2/);
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
        "✎ exception record written to .pocket-zipper/exceptions.yml",
        "it takes effect only once the change is approved and merged.",
        ...nextSteps,
      ),
    );
    assert.match(r.read(".pocket-zipper/exceptions.yml"), /line: 2/);
  });

  it("refuses a non-interactive session without a reason", () => {
    const r = wizardRepo({ config: configYaml({ enabled: true }) });
    singleDebt(r);
    const res = r.runCli(["exception", "add", "--from", "app.js:2"], { json: false });
    assert.equal(res.status, 1);
    assert.equal(res.stderr, "the reason is required — pass it with --reason <text>\n");
    assert.ok(!existsSync(join(r.dir, ".pocket-zipper/exceptions.yml")));
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

  it("refuses a --from that cannot pick between two suppressions on one line", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error", "no-debugger": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
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
    assert.ok(!existsSync(join(r.dir, ".pocket-zipper/exceptions.yml")));
  });
});
