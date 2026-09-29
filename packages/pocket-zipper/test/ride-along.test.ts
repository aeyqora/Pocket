import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { main, type CommandIo } from "../src/cli.js";
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

/**
 * A repo with a committed change that adds governed debt: the shape a developer's
 * `check` FAILs on, where the suppression is already in the branch tip the gate
 * compared. Returns the ref to check against.
 */
function failingRepo(): { repo: FixtureRepo; base: string } {
  const r = createRepo();
  repos.push(r);
  r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
  r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
  r.write("app.js", "export const a = 1;\n");
  r.commit("base");
  const base = r.rev("HEAD");
  r.write("app.js", "export const a = 1;\n// eslint-disable-next-line no-console\nconsole.log(1);\n");
  r.commit("add the debt");
  return { repo: r, base };
}

/** The same repo, failing on two same-file twins: the multi-debt ride-along. */
function twinFailingRepo(): { repo: FixtureRepo; base: string } {
  const r = createRepo();
  repos.push(r);
  r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
  r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
  r.write("app.js", "export const a = 1;\n");
  r.commit("base");
  const base = r.rev("HEAD");
  r.write(
    "app.js",
    "export const a = 1;\n// eslint-disable-next-line no-console\nconsole.log(1);\n// eslint-disable-next-line no-console\nconsole.log(2);\n",
  );
  r.commit("add the debt");
  return { repo: r, base };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A frozen transcript: the exact bytes of one run's output, one string per line. */
function t(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

/**
 * One flagged entry's copy-paste-ready record: the match fields, the two
 * human-authored placeholders, and the concrete date — the block the ride-along's
 * prefill is populated from, and the proof that nothing in the written record is
 * hand-copied.
 */
function remediation(line: number, defaultExpiry = addDuration(today(), "30d")): string[] {
  return [
    "    remediate with:",
    "    - rule: no-console",
    "      suppression_type: next-line",
    `      fingerprint: ${NEXT_LINE_NO_CONSOLE_FP}`,
    "      file: app.js",
    "      type: temporary",
    "      reason: <why this suppression is necessary>",
    "      reference: <issue or PR link>",
    `      expires: ${defaultExpiry}`,
    `      line: ${line}`,
  ];
}

/** The FAIL report every single-debt ride-along transcript continues from. */
function failReport(defaultExpiry: string): string[] {
  return [
    "pocket-zipper: FAIL",
    "  existing: 0  moved-existing: 0  removed: 0  new: 1  materially-changed: 0",
    "",
    "For this rule at this file: 0 matching records, 0 used, 0 leftover",
    "",
    "New suppression debt requiring an exception:",
    "  app.js:2  no-console  (next-line, directive, new)",
    ...remediation(2, defaultExpiry),
  ];
}

/**
 * `check` in-process, optionally at a terminal. The one deliberate unit seam: a
 * piped CLI subprocess is never a TTY, so the ride-along's offer is unreachable
 * through the harness — the same seam the report's colour branch is tested
 * through. Colour is stripped from what comes back: at a terminal the report is
 * colourised, and these transcripts are about the words.
 */
async function checkAtTerminal(
  r: FixtureRepo,
  base: string,
  script: string,
  tty = true,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const sink = (write: (text: string) => void): Writable =>
    new Writable({
      write(chunk, _encoding, done) {
        write(chunk.toString().replace(/\u001b\[\d+m/g, ""));
        done();
      },
    });
  const io: CommandIo = {
    cwd: r.dir,
    input: Readable.from(script),
    output: sink((text) => {
      stdout += text;
    }),
    stderr: sink((text) => {
      stderr += text;
    }),
    tty,
  };
  const exitCode = await main(["check", "--base", base], io);
  return { exitCode, stdout, stderr };
}

describe("the ride-along: the post-failure door into the wizard", () => {
  it("hands the failing suppression to the session, pre-selected", async () => {
    const { repo: r, base } = failingRepo();
    const d = today();
    const defaultExpiry = addDuration(d, "30d");
    const res = await checkAtTerminal(
      r,
      base,
      "y\nNeeded for the debug toolbar.\nhttps://github.com/org/repo/issues/123\n\ny\n\n",
    );
    // The gate's verdict stands: authoring the record is not the change that
    // authorizes it, so the run that offered it still exits 1.
    assert.equal(res.exitCode, 1);
    assert.equal(
      res.stdout,
      t(
        ...failReport(defaultExpiry),
        // The selection is stated before the question: one `y` authorizes a
        // record for every flagged suppression, so the author sees the list.
        "◉ selected  app.js:2  no-console  (next-line)",
        "create an exception for this debt? [y/N]",
        "❯ y",
        // No session choice, no pick: the failure already identified the debt.
        "reason for the exception (required):",
        "❯ Needed for the debug toolbar.",
        "reference (issue / PR / ticket link) — optional; Enter to skip:",
        "❯ https://github.com/org/repo/issues/123",
        `a default expiry of ${defaultExpiry} (30 days from today) is set — accept it? [Y/n]`,
        `expiry: ${defaultExpiry}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${defaultExpiry}`,
        "    reason:    Needed for the debug toolbar.",
        "    reference: https://github.com/org/repo/issues/123",
        "write the exception? [y/N]",
        "❯ y",
        "✎ exception record written to .pocket-zipper/exceptions.yml",
        "it takes effect only once the change is approved and merged.",
        "",
        "Next steps",
        "  1. land the record in its own PR — an approver reviews and merges it",
        "  2. once merged, land the code change that adds the suppression",
        "run another session? [y/N]",
      ),
    );
    // The prefill is the report's own record: the same fingerprint, the same
    // line, the same concrete date the report suggested — one `now` behind both.
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
        `  expires: ${defaultExpiry}`,
        "  line: 2",
      ),
    );
    assert.equal(r.runCli(["validate"], { json: false }).status, 0);
  });

  it("states the whole selection before one `y` authorizes a record for each", async () => {
    // A FAIL can flag several suppressions, and one `y` writes a record for
    // every one of them. The list is therefore printed before the question, and
    // the shared-reason question is what decides whether they are one answer or
    // N.
    const { repo: r, base } = twinFailingRepo();
    const defaultExpiry = addDuration(today(), "30d");
    const res = await checkAtTerminal(r, base, "y\n\nOne reason covers both.\n\n\ny\n\n");
    assert.equal(res.exitCode, 1);
    assert.equal(
      res.stdout,
      t(
        "pocket-zipper: FAIL",
        "  existing: 0  moved-existing: 0  removed: 0  new: 2  materially-changed: 0",
        "",
        "For this rule at this file: 0 matching records, 0 used, 0 leftover",
        "",
        "New suppression debt requiring an exception:",
        "  app.js:2  no-console  (next-line, directive, new)",
        ...remediation(2),
        "  app.js:4  no-console  (next-line, directive, new)",
        ...remediation(4),
        "◉ selected  app.js:2  no-console  (next-line)",
        "◉ selected  app.js:4  no-console  (next-line)",
        "create an exception for this debt? [y/N]",
        "❯ y",
        "Do these 2 exceptions all share one reason? [Y/n]",
        "reason for the exception (required):",
        "❯ One reason covers both.",
        "reference (issue / PR / ticket link) — optional; Enter to skip:",
        "reference (issue / PR / ticket link) — optional: Skipped",
        `a default expiry of ${defaultExpiry} (30 days from today) is set — accept it? [Y/n]`,
        `expiry: ${defaultExpiry}`,
        "Review — the record(s) to write:",
        `  • no-console @ app.js:2 — next-line (new) — expires ${defaultExpiry}`,
        "    reason:    One reason covers both.",
        `  • no-console @ app.js:4 — next-line (new) — expires ${defaultExpiry}`,
        "write the exception? [y/N]",
        "❯ y",
        "✎ exception records written to .pocket-zipper/exceptions.yml",
        "it takes effect only once the change is approved and merged.",
        "",
        "Next steps",
        "  1. land the record in its own PR — an approver reviews and merges it",
        "  2. once merged, land the code change that adds the suppression",
        "run another session? [y/N]",
      ),
    );
    // One record per suppression, the pair the twins need: two records, not one.
    assert.equal(r.read(".pocket-zipper/exceptions.yml").split("- rule:").length - 1, 2);
  });

  it("runs one ride-along per invocation, then hands over to the command", async () => {
    // The ride-along is the first session of the invocation and only the first:
    // a second session is `exception add` in its own right, so it gets the
    // session choice the failure skipped.
    const { repo: r, base } = failingRepo();
    const res = await checkAtTerminal(r, base, "y\nNeeded.\n\n\ny\ny\n1\n");
    assert.equal(res.exitCode, 1);
    assert.match(
      res.stdout,
      /run another session\? \[y\/N\]\n❯ y\nreading the working tree's new debt…\nthis session is for:\n {2}1\) new debt from this change\n {2}2\) renew an expiring record\nchoose — 1 \(new debt\) or 2 \(renew\):\n❯ 1\n→ new debt\nno new debt from this change requires an exception\.\n$/,
    );
  });

  it("offers nothing when the author declines, and writes nothing", async () => {
    const { repo: r, base } = failingRepo();
    const res = await checkAtTerminal(r, base, "n\n");
    assert.equal(res.exitCode, 1);
    assert.equal(
      res.stdout,
      t(
        ...failReport(addDuration(today(), "30d")),
        "◉ selected  app.js:2  no-console  (next-line)",
        "create an exception for this debt? [y/N]",
        "❯ n",
      ),
    );
    assert.ok(!existsSync(join(r.dir, ".pocket-zipper/exceptions.yml")));
  });

  it("asks nothing where the report is machine-bound, so a gate never blocks", async () => {
    // A hook or a CI step: the report is going where nobody is reading it, so
    // there is nobody to answer the offer.
    const { repo: r, base } = failingRepo();
    const res = await checkAtTerminal(r, base, "y\n", false);
    assert.equal(res.exitCode, 1);
    assert.equal(res.stdout, t(...failReport(addDuration(today(), "30d"))));
    assert.ok(!existsSync(join(r.dir, ".pocket-zipper/exceptions.yml")));
  });

  it("asks nothing on a --json run at a terminal, where the record is the reader", async () => {
    const { repo: r, base } = failingRepo();
    let stdout = "";
    const exitCode = await main(
      ["check", "--base", base, "--json", join(r.dir, "record.json")],
      {
        cwd: r.dir,
        input: Readable.from("y\n"),
        output: new Writable({
          write(chunk, _encoding, done) {
            stdout += chunk.toString().replace(/\u001b\[\d+m/g, "");
            done();
          },
        }),
        stderr: new Writable({ write: (_c, _e, done) => done() }),
        tty: true,
      },
    );
    assert.equal(exitCode, 1);
    assert.equal(stdout, t(...failReport(addDuration(today(), "30d"))));
    assert.ok(!existsSync(join(r.dir, ".pocket-zipper/exceptions.yml")));
  });

  it("offers nothing on a passing check", async () => {
    const r = createRepo();
    repos.push(r);
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    const res = await checkAtTerminal(r, r.rev("HEAD"), "y\n");
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, t("pocket-zipper: PASS"));
  });
});
