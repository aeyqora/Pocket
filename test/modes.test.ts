import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRepo, eslintConfig, type FixtureRepo } from "./harness.js";

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

function repo(): FixtureRepo {
  const r = createRepo();
  repos.push(r);
  return r;
}

const disabled = "// eslint-disable-next-line no-console\n";

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
});
