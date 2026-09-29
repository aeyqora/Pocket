import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRepo,
  eslintConfig,
  exceptionYaml,
  NEXT_LINE_NO_CONSOLE_FP,
  NEXT_LINE_NO_DEBUGGER_FP,
  type FixtureRepo,
} from "./harness.js";
import { addDuration } from "../src/policy.js";
import { evaluate } from "../src/pipeline.js";

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

function repo(): FixtureRepo {
  const r = createRepo();
  repos.push(r);
  return r;
}

const REGISTRY = ".pocket-zipper/exceptions.yml";
const noConsole = "// eslint-disable-next-line no-console\n";

const TODAY = new Date().toISOString().slice(0, 10);
const IN_WINDOW = addDuration(TODAY, "30d");
const LONG_PAST = "2000-01-01";

/** One record, 8 lines with no `line` and 9 with one. */
function record(overrides: Partial<Parameters<typeof exceptionYaml>[0]> = {}): string {
  return exceptionYaml({
    rule: "no-console",
    suppressionType: "next-line",
    fingerprint: NEXT_LINE_NO_CONSOLE_FP,
    file: "app.js",
    type: "temporary",
    expires: IN_WINDOW,
    ...overrides,
  });
}

/**
 * The unused records an evaluation derived. Read off the evaluation result
 * rather than the JSON record on purpose: the addresses are a report-only shape,
 * and the record's schema is frozen at v1.
 */
async function unused(r: FixtureRepo, base = "base") {
  const { unused: derived } = await evaluate({ mode: "check", cwd: r.dir, baseRef: base });
  return derived;
}

/** The report's delete-ready pointer lines, one per unused record. */
function pointers(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.trimStart().startsWith("entry "));
}

const registryRef = REGISTRY.replace(/\./g, "\\.");

/**
 * A change that introduces new debt in `other.js` while leaving the registry
 * alone. The section under test is a FAIL's, and a record the change did not
 * touch is what a FAIL's cleanup section is actually about: the new debt is only
 * the reason there is a report to read. Already committed — the caller commits
 * anything else around it.
 *
 * The directive is `line`-form on purpose: identity is blind to path and
 * guarded code, so a `next-line` twin of a baseline directive would reconcile
 * as moved-existing debt and fail nothing.
 */
function failingChange(r: FixtureRepo): void {
  r.write("other.js", "export const o = 1;\n// eslint-disable-line no-console\nconsole.log(9);\n");
  r.commit("add fresh debt");
}

/**
 * A change that removes the suppression one record excepts, alongside the fresh
 * debt that makes the gate fail so the cleanup section prints. The record is
 * then unused *because of this change*, which is the only annotation the change
 * earns.
 */
function clearingChange(r: FixtureRepo): void {
  r.write("app.js", "export const a = 1;\n");
  r.write("other.js", "export const o = 1;\n// eslint-disable-line no-console\nconsole.log(9);\n");
  r.commit("fix the suppression, add fresh debt");
}

describe("the FAIL cleanup section: a delete-ready pointer per unused record", () => {
  it("names the entry, the line span, and the record's full text", async () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record());
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    failingChange(r);

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    const [pointer] = pointers(res.stdout);
    // The pointer is the spec's literal and nothing else: entry, of how many,
    // the file, the line span. A CI step and a maintainer's muscle memory both
    // key on this exact string.
    assert.equal(pointer?.trim(), `entry 1 of 1 · ${REGISTRY}:1-8`);
    // Status and location ride on the next line, so they never break the
    // pointer's greppable shape.
    const lines = res.stdout.split("\n");
    const after = lines.slice(lines.indexOf(pointer!));
    assert.match(after[1]!, /dangling; no line recorded/);
    // The record's own text, so the pointer is confirmed before it is cut.
    const block = res.stdout.slice(res.stdout.indexOf(pointer!));
    assert.match(block, /- rule: no-console/);
    assert.match(block, new RegExp(`fingerprint: ${NEXT_LINE_NO_CONSOLE_FP}`));
    assert.match(block, /reason: needed/);
    assert.match(block, new RegExp(`expires: ${IN_WINDOW}`));
  });

  it("gives each record its own span, so a pointer never names a live record's lines", async () => {
    // Two records, both unused. A span that ran past its record would name the
    // second record's lines for the first, and cutting the first would take a
    // record still in use with it.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error", "no-debugger": "error" }));
    r.write(
      REGISTRY,
      record() +
        exceptionYaml({
          rule: "no-debugger",
          suppressionType: "next-line",
          fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
          file: "tools.js",
          expires: IN_WINDOW,
        }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.write("tools.js", "export const t = 1;\n");
    r.commit("base");
    r.branch("base");
    failingChange(r);

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    const derived = await unused(r);
    assert.deepEqual(
      derived.map((u) => [u.entry, u.entries, u.span, u.status]),
      [
        [1, 2, { start: 1, end: 8 }, "dangling"],
        [2, 2, { start: 9, end: 16 }, "dangling"],
      ],
    );
    const [first, second] = pointers(res.stdout);
    assert.equal(first?.trim(), `entry 1 of 2 · ${REGISTRY}:1-8`);
    assert.equal(second?.trim(), `entry 2 of 2 · ${REGISTRY}:9-16`);
  });

  it("counts the entries the registry holds, not the ones it happens to have unused", async () => {
    // Three records, one unused: `entry 1 of 3` is the position a maintainer
    // counts to, and it stays the same whichever record the report is talking
    // about. Records 2 and 3 authorize debt this change introduces — a record
    // doing its job is not cleanup, and it gets no pointer at all.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error", "no-debugger": "error" }));
    r.write(
      REGISTRY,
      record() +
        record({ rule: "no-debugger", fingerprint: NEXT_LINE_NO_DEBUGGER_FP, file: "tools.js" }) +
        record({ rule: "no-debugger", fingerprint: NEXT_LINE_NO_DEBUGGER_FP, file: "deep.js" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.write("tools.js", "export const t = 1;\n");
    r.write("deep.js", "export const d = 1;\n");
    r.commit("base");
    r.branch("base");
    // The two records' suppressions land with the debt they authorize; the
    // first record's suppression is nowhere to be found.
    r.write("tools.js", "export const t = 1;\n// eslint-disable-next-line no-debugger\ndebugger;\n");
    r.write("deep.js", "export const d = 1;\n// eslint-disable-next-line no-debugger\ndebugger;\n");
    failingChange(r);

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 2);
    const [pointer] = pointers(res.stdout);
    assert.equal(pointer?.trim(), `entry 1 of 3 · ${REGISTRY}:1-8`);
    assert.deepEqual(
      (await unused(r)).map((u) => [u.entry, u.entries, u.status]),
      [[1, 3, "dangling"]],
    );
    assert.equal(res.stdout.includes("entry 2 of 3"), false);
    assert.equal(res.stdout.includes("entry 3 of 3"), false);
  });
});

describe("a record listed next to its suppression shows where it is now", () => {
  it("names the current line, and the drift beside it as information", async () => {
    // Spent: the record's suppression became pre-existing debt. It is still
    // there, and it is no longer where the record remembers — so the pointer
    // names where it is, and says what the record says only as the drift it is.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record({ line: 2 }));
    r.write("app.js", `export const a = 1;\n${noConsole}console.log(1);\n`);
    r.commit("base");
    r.branch("base");
    // Code grows above the directive: it moves to line 6 and stays continuous.
    r.write(
      "app.js",
      `export const b = 2;\nexport const c = 3;\nexport const d = 4;\n${noConsole}console.log(1);\n`,
    );
    failingChange(r);

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    const [entry] = await unused(r);
    assert.equal(entry?.status, "spent");
    assert.deepEqual(entry?.live, { file: "app.js", line: 4 });
    assert.equal(entry?.recorded, 2);
    assert.match(
      res.stdout,
      /spent; at app\.js:4 \(record says 2, currently at 4\)/,
    );
  });

  it("says last known where nothing matches the record any more", async () => {
    // Dangling: the suppression is gone, so there is no current location to
    // name, and the record's stored line is honestly the last one it knew.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record({ line: 2 }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    failingChange(r);

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    const [entry] = await unused(r);
    assert.equal(entry?.status, "dangling");
    assert.equal(entry?.live, null);
    assert.match(res.stdout, /dangling; last known: 2/);
  });

  it("says a record with no stored line has none, rather than inventing one", async () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record());
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    failingChange(r);

    const res = r.runCli(["check", "--base", "base"]);
    assert.match(res.stdout, /dangling; no line recorded/);
    assert.equal((await unused(r))[0]?.recorded, null);
  });
});

describe("the `cleared by this change` annotation", () => {
  it("names the record the change orphaned, so its author learns it here", async () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record());
    r.write("app.js", `export const a = 1;\n${noConsole}console.log(1);\n`);
    r.commit("base");
    r.branch("base");
    clearingChange(r);

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal((await unused(r))[0]?.clearedByThisChange, true);
    // The one message in the report that reaches the author of the change.
    assert.match(
      res.stdout,
      /cleared by this change — record now unused; remove it in a protected PR/,
    );
    // And it sits inside the record's own block, under the pointer it is about.
    const pointer = pointers(res.stdout)[0]!;
    const lines = res.stdout.split("\n");
    const block = lines.slice(lines.indexOf(pointer), lines.indexOf(pointer) + 4);
    assert.match(block.join("\n"), /cleared by this change/);
  });

  it("leaves a record the change did not clear unannotated", async () => {
    // Already dangling at the baseline: nobody ever fixed the suppression this
    // record excepts, and this change removes something else. Saying "cleared
    // by this change" would accuse the author of a mess they did not make.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error", "no-debugger": "error" }));
    r.write(REGISTRY, record());
    r.write("app.js", "export const a = 1;\n");
    r.write("tools.js", "// eslint-disable-next-line no-debugger\ndebugger;\n");
    r.commit("base");
    r.branch("base");
    r.write("tools.js", "export const t = 1;\n");
    failingChange(r);

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal((await unused(r))[0]?.clearedByThisChange, false);
    assert.doesNotMatch(res.stdout, /cleared by this change/);
  });
});

describe("the cleanup section header carries the guide", () => {
  it("points at the cleaning guide where the records are", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record());
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    failingChange(r);

    const res = r.runCli(["check", "--base", "base"]);
    // The remedy rides in the header, not in a line beneath it: a reader who
    // scans only the header of a section listing records to delete is exactly
    // the reader the pointer is for. The guide is where the maintainer's
    // `git blame` technique lives.
    assert.match(
      res.stdout,
      /^Unused exceptions: dangling 1, spent 0, expired 0 — remove each in a protected PR; see docs\/guides\/cleaning-up-unused-exceptions\.md$/m,
    );
  });
});

describe("the greppable cleanup rollup", () => {
  /** A passing change that leaves one record unused. */
  function passingWithDangling(): FixtureRepo {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record());
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("other.js", "export const o = 1;\n");
    r.commit("bystander");
    return r;
  }

  it("prints bare counts on a verbose pass, for the repo's own CI to pipe", () => {
    const r = passingWithDangling();
    // A pass is one verdict line by default, and says its counts only when
    // asked. What it says is pipeable and names no one: the core posts nothing.
    const plain = r.runCli(["check", "--base", "base"]);
    assert.equal(plain.status, 0);
    assert.equal(plain.stdout, "pocket-zipper: PASS\n");
    assert.doesNotMatch(plain.stdout, /pocket-zipper-cleanup:/);

    const verbose = r.runCli(["check", "--base", "base", "--verbose"]);
    assert.equal(verbose.status, 0);
    assert.match(verbose.stdout, /^pocket-zipper-cleanup: 1 dangling, 0 spent$/m);
  });

  it("keeps the overlong line beside it on a verbose pass", () => {
    // The record is overlong *and* unused here, so the section has a tally to
    // sit beside. A record that is overlong but still authorizing is its own
    // case, and gets the line on its own.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record({ expires: addDuration(TODAY, "6mo") }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("other.js", "export const o = 1;\n");
    r.commit("bystander");

    const res = r.runCli(["check", "--base", "base", "--verbose"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^Unused exceptions: dangling 1, spent 0, expired 0$/m);
    assert.match(res.stdout, /^  Overlong exceptions: 1 \(expires past the 3mo maximum\)$/m);
  });

  it("prints the overlong line on its own when nothing is unused", () => {
    // A far-future record still authorizing its suppression is hygiene, not
    // cleanup: it is not in the unused tally, and it still says so.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record({ expires: addDuration(TODAY, "6mo") }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${noConsole}console.log(1);\n`);
    r.commit("add the debt it authorizes");

    const res = r.runCli(["check", "--base", "base", "--verbose"]);
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stdout, /Unused exceptions/);
    assert.doesNotMatch(res.stdout, /pocket-zipper-cleanup:/);
    assert.match(res.stdout, /^  Overlong exceptions: 1 \(expires past the 3mo maximum\)$/m);
  });
});

describe("validate: the same pointers, as hygiene", () => {
  it("prints an unused record's pointer and still exits 0", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record({ line: 7 }));
    r.write("app.js", "export const a = 1;\n");

    const res = r.runCli(["validate"], { json: false });
    // Hygiene, not a defect: the documented two-step landing writes a record
    // before its suppression lands, so failing here would punish the workflow.
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^pocket-zipper: OK \(0 defects/m);
    assert.match(res.stdout, /Unused exceptions: dangling 1, spent 0, expired 0/);
    assert.match(res.stdout, new RegExp(`entry 1 of 1 · ${registryRef}:1-9`));
    assert.match(res.stdout, /last known: 7/);
    assert.match(res.stdout, /- rule: no-console/);
    // The greppable rollup rides along: a repo's CI should find the line
    // wherever the tool runs, and the sweep is where the counts earn their keep.
    assert.match(res.stdout, /^pocket-zipper-cleanup: 1 dangling, 0 spent$/m);
  });

  it("prints the pointer at the current location, drift and all", () => {
    // The record is expired, its stored line is 12, and its suppression has
    // drifted to line 141 — the exact numbers the informational clause names.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record({ line: 12, expires: LONG_PAST }));
    r.write(
      "app.js",
      `${Array.from({ length: 140 }, (_, i) => `export const v${i} = ${i};`).join("\n")}\n${noConsole}console.log(1);\n`,
    );

    const res = r.runCli(["validate"], { json: false });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Unused exceptions: dangling 0, spent 0, expired 1/);
    assert.match(
      res.stdout,
      /entry 1 of 1 · \.pocket-zipper\/exceptions\.yml:1-9\n {4}expired; at app\.js:141 \(record says 12, currently at 141\)/,
    );
  });

  it("says nothing at all about a registry with nothing unused", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record());
    r.write("app.js", `export const a = 1;\n${noConsole}console.log(1);\n`);

    const res = r.runCli(["validate"], { json: false });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "pocket-zipper: OK (0 defects, 0 hygiene findings)\n");
  });
});

/**
 * The posture the whole surface rests on, asserted rather than documented: a
 * run that names records to delete changes nothing.
 */
describe("the core never deletes a record", () => {
  it("leaves the registry byte for byte after naming records for deletion", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(REGISTRY, record());
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    failingChange(r);
    const before = r.read(REGISTRY);

    const failing = r.runCli(["check", "--base", "base"]);
    assert.equal(pointers(failing.stdout).length, 1);
    assert.equal(r.read(REGISTRY), before);

    const validated = r.runCli(["validate"], { json: false });
    assert.equal(pointers(validated.stdout).length, 1);
    assert.equal(r.read(REGISTRY), before);
  });

  it("lints the working tree's own registry, including a record it has not committed", () => {
    // The record on disk is the one the maintainer is about to sweep, whether or
    // not it has been committed yet.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.write(REGISTRY, record());

    const res = r.runCli(["validate"], { json: false });
    assert.equal(res.status, 0);
    assert.match(res.stdout, new RegExp(`entry 1 of 1 · ${registryRef}`));
  });
});
