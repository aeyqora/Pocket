import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createRepo,
  configYaml,
  eslintConfig,
  exceptionYaml,
  hasErrorCode,
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

const disabled = "// eslint-disable-next-line no-console\n";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Real today and a date past the default 3mo max — the staged-side fixture. */
const TODAY = new Date().toISOString().slice(0, 10);
const BEYOND_HORIZON = addDuration(TODAY, "6mo");

function noConsoleException(): string {
  return exceptionYaml({
    rule: "no-console",
    suppressionType: "next-line",
    fingerprint: NEXT_LINE_NO_CONSOLE_FP,
    file: "app.js",
    expires: "2099-01-01",
  });
}

describe("CI merge-result-first tree resolution", () => {
  it("uses the merge result's first parent as the baseline", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("A");
    r.branch("base");

    r.checkout("base", { create: "feature" });
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("B");

    r.checkout("main");
    r.write("other.js", "export const c = 1;\n");
    const cSha = r.commit("C");

    r.checkout("main", { create: "mr" });
    r.git(["merge", "--no-ff", "-m", "merge feature", "feature"]);

    const cTree = r.git(["rev-parse", `${cSha}^{tree}`]).trim();
    const mTree = r.git(["rev-parse", "HEAD^{tree}"]).trim();
    const res = r.runCli(["check", "--base", "main"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.dispositions.new, 1);
    assert.equal(res.record?.baseline.tree, cTree);
    assert.equal(res.record?.proposedChange.tree, mTree);
  });

  it("resolves a raw branch against the computed merge-base", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    const aSha = r.commit("A");
    r.branch("base");

    r.write("other.js", "export const c = 1;\n");
    const cSha = r.commit("C");

    const aTree = r.git(["rev-parse", `${aSha}^{tree}`]).trim();
    const cTree = r.git(["rev-parse", `${cSha}^{tree}`]).trim();
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.record?.baseline.ref, "base");
    assert.equal(res.record?.baseline.tree, aTree);
    assert.equal(res.record?.proposedChange.tree, cTree);
  });
});

describe("pre-commit mode", () => {
  it("fails a staged new governed suppression", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.stage("app.js");
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.mode, "pre-commit");
    assert.equal(res.record?.summary.dispositions.new, 1);
  });

  it("ignores worktree-only edits and stays silent on the happy path", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
  });

  it("handles an unborn HEAD with the empty-tree baseline", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.stage();
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.baseline.tree, EMPTY_TREE);
    assert.equal(res.record?.summary.dispositions.new, 1);
    assert.ok(res.record?.inventory.every((e) => e.disposition === "new"));
  });

  it("evaluates staged blobs, not the worktree", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    // Stage a suppression, then remove it from the worktree without staging.
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.stage("app.js");
    r.write("app.js", "export const a = 1;\n");
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.dispositions.new, 1);
  });

  it("reports a staged deletion as removed and passes", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("base");
    r.write("app.js", "export const a = 1;\n");
    r.stage("app.js");
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.removed, 1);
  });

  it("carries a staged rename as moved-existing", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("utils.js", `${disabled}console.log(1);\n`);
    r.commit("base");
    r.mkdir("lib");
    r.git(["mv", "utils.js", "lib/utils.js"]);
    r.stage();
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.movedExisting, 1);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });

  it("carries staged movement within a file as moved-existing", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", `foo();\n${disabled}console.log(1);\n`);
    r.commit("base");
    r.write("app.js", `foo();\nbar();\n${disabled}console.log(1);\n`);
    r.stage("app.js");
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.movedExisting, 1);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });

  it("passes silently with an empty staged diff", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
    assert.deepEqual(res.record?.inventory, []);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });

  it("passes with multiple staged files carrying only movement", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("a.js", `foo();\n${disabled}console.log(1);\n`);
    r.write("b.js", `${disabled}console.log(2);\nbar();\n`);
    r.commit("base");
    r.write("a.js", `foo();\nbar();\n${disabled}console.log(1);\n`);
    r.write("b.js", `bar();\n${disabled}console.log(2);\nfoo();\n`);
    r.stage();
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.movedExisting, 2);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });

  it("emits a verdict line on a verbose pass", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    const res = r.runCli(["pre-commit", "--verbose"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /PASS/);
  });

  it("includes remediation in the staged fail report", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.stage("app.js");
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /FAIL/);
    assert.match(res.stdout, /suppression_type: next-line/);
  });

  it("authorizes a staged suppression from the committed registry", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/exceptions.yml", noConsoleException());
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.stage("app.js");
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
  });

  it("surfaces authorized debt and dispositions on a verbose pass", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/exceptions.yml", noConsoleException());
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.stage("app.js");
    const res = r.runCli(["pre-commit", "--verbose"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /PASS/);
    assert.match(res.stdout, /new: 1/);
    assert.match(res.stdout, /New suppression debt authorized by exception:/);
    assert.match(res.stdout, /app\.js:\d+\s+no-console\s+\(next-line\)/);
  });

  it("does not authorize a staged exception and suppression in the same change", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.write(".pocket-zipper/exceptions.yml", noConsoleException());
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.stage();
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 0);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
  });

  it("refuses a staged record past the committed maximum", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    // The record is staged, nothing else: the refusal is the expiry policy's,
    // judged against HEAD's maximum, not a debt failure.
    r.write(
      ".pocket-zipper/exceptions.yml",
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: BEYOND_HORIZON,
      }),
    );
    r.stage();
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.mode, "pre-commit");
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    assert.ok(hasErrorCode(res.record, "EXPIRY_POLICY"));
  });

  /**
   * The pre-commit side of the protected-file trigger. `CONTEXT.md` says the
   * proposed change in this mode is the staged index; the worktree is read only
   * for what the index does not carry.
   */
  it("judges nothing when a registry in the worktree is not staged", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    // Written and never staged, beside an empty staged diff. The proposed
    // change is the index, and it carries nothing.
    r.write(".pocket-zipper/exceptions.yml", noConsoleException());
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.errors, []);
  });

  it("judges nothing from a worktree registry it could not stage", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.write(".pocket-zipper/exceptions.yml", noConsoleException());
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    // A locked index is not a thing an author does on purpose; it is what a
    // hook racing another writer looks like. It is here because it is the one
    // way the staged index stops being readable, and the fallback then reads
    // the *worktree* — where a registry the change never staged is sitting. The
    // change still contains nothing; the file it does not carry must not decide
    // whether the change passes.
    writeFileSync(join(r.dir, ".git", "index.lock"), "");
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.errors, []);
  });

  it("judges nothing from a worktree config it could not stage", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    // The other protected file, on the same locked-index path, and the same
    // reason the fallback reaches the worktree: `config.yml` is not in the index
    // at all, so the head read has nothing staged to return and falls through to
    // the worktree, where `enabled: false` is sitting untracked. Without a
    // baseline `config.yml` the two documents differ, so an ungated
    // `configWeakened` reports a weakening for a file the change never carried.
    // The firing side is already pinned by "fails when a weakening edit is
    // consumed by new debt in the same change"; what this closes is the gate.
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: false }));
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    writeFileSync(join(r.dir, ".git", "index.lock"), "");
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.errors, []);
  });

  it("judges the same registry once it is staged", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    // The mirror of the two tests above, and the guard on them: the same
    // registry, the same date, one `stage()` apart. If the trigger had been
    // satisfied by switching the check off, this would pass too.
    r.write(".pocket-zipper/exceptions.yml", noConsoleException());
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.stage();
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "EXPIRY_POLICY"));
  });
});
