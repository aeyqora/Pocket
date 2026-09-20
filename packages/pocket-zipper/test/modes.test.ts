import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRepo,
  eslintConfig,
  exceptionYaml,
  NEXT_LINE_NO_CONSOLE_FP,
  type FixtureRepo,
} from "./harness.js";

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

function repo(): FixtureRepo {
  const r = createRepo();
  repos.push(r);
  return r;
}

const disabled = "// eslint-disable-next-line no-console\n";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
});
