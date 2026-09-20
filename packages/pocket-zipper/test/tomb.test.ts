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

const noConsoleNextLine = "// eslint-disable-next-line no-console\n";

describe("the tomb rule", () => {
  it("marks the full lookalike as materially-changed with remediation", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      "gate.js",
      `${noConsoleNextLine}console.log("existing-1");\nwork();\n${noConsoleNextLine}console.log("existing-2");\nend();\n`,
    );
    r.commit("base");
    r.branch("base");
    r.write(
      "gate.js",
      `${noConsoleNextLine}console.log("existing-1");\nwork();\nend();\nfeature();\n${noConsoleNextLine}console.log("brand-new");\n`,
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    const d = res.record!.summary.dispositions;
    assert.equal(d.materiallyChanged, 1);
    assert.equal(d.new, 0);
    assert.equal(d.existing, 1);
    assert.match(res.stdout, /materially-changed/);
    assert.match(res.stdout, /suppression_type: next-line/);
  });

  it("does not tomb an in-place rewrite where the comment is unchanged", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("debug.js", `${noConsoleNextLine}console.log(before);\n`);
    r.commit("base");
    r.branch("base");
    r.write("debug.js", `${noConsoleNextLine}console.log(anEntirelyDifferent(expression));\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const d = res.record!.summary.dispositions;
    assert.equal(d.materiallyChanged, 0);
    assert.equal(d.new, 0);
  });

  it("does not tomb a re-indented rewrite (newborn judged on canonical text)", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("debug.js", `function f() {\n${noConsoleNextLine}console.log(before);\n}\n`);
    r.commit("base");
    r.branch("base");
    r.write("debug.js", `function f() {\n    ${noConsoleNextLine}console.log(after);\n}\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const d = res.record!.summary.dispositions;
    assert.equal(d.materiallyChanged, 0);
    assert.equal(d.new, 0);
  });

  it("tombstones when the twin's guarded statement is removed", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("gate.js", `${noConsoleNextLine}console.log("a");\nwork();\n${noConsoleNextLine}console.log("dead");\n`);
    r.commit("base");
    r.branch("base");
    r.write(
      "gate.js",
      `${noConsoleNextLine}console.log("a");\nwork();\nend();\nfeature();\n${noConsoleNextLine}console.log("brand-new");\n`,
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.dispositions.materiallyChanged, 1);
  });

  it("does not tomb a line-form rewrite (comment shares the guarded line)", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("debug.js", "console.log(before); // eslint-disable-line no-console\n");
    r.commit("base");
    r.branch("base");
    r.write("debug.js", "console.log(after); // eslint-disable-line no-console\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const d = res.record!.summary.dispositions;
    assert.equal(d.materiallyChanged, 0);
    assert.equal(d.new, 0);
  });

  it("does not tomb when a justification edit accompanies a rewrite", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      "debug.js",
      "// eslint-disable-next-line no-console -- old reason\nconsole.log(before);\n",
    );
    r.commit("base");
    r.branch("base");
    r.write(
      "debug.js",
      "// eslint-disable-next-line no-console -- new reason\nconsole.log(after);\n",
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const d = res.record!.summary.dispositions;
    assert.equal(d.materiallyChanged, 0);
    assert.equal(d.new, 0);
  });

  it("does not tomb an added directive whose guarded statement already exists in the baseline", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      "app.js",
      `${noConsoleNextLine}console.log("keep-me");\n${noConsoleNextLine}console.log("remove-me");\n`,
    );
    r.commit("base");
    r.branch("base");
    r.write(
      "app.js",
      `${noConsoleNextLine}console.log("keep-me");\nwork();\n${noConsoleNextLine}console.log("keep-me");\n`,
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const d = res.record!.summary.dispositions;
    assert.equal(d.materiallyChanged, 0);
    assert.equal(d.new, 0);
  });
});

describe("region forms are continuity-decided, never tomb-classified", () => {
  it("keeps a block directive with changed region content as existing debt", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      "app.js",
      `/* eslint-disable no-console */\nconsole.log("a");\n/* eslint-enable no-console */\n`,
    );
    r.commit("base");
    r.branch("base");
    r.write(
      "app.js",
      `/* eslint-disable no-console */\nconsole.log("b");\n/* eslint-enable no-console */\n`,
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const d = res.record!.summary.dispositions;
    assert.equal(d.materiallyChanged, 0);
    assert.equal(d.new, 0);
  });

  it("keeps a file-level directive with changed content as existing debt", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", `/* eslint-disable no-console */\nconsole.log("a");\n`);
    r.commit("base");
    r.branch("base");
    r.write("app.js", `/* eslint-disable no-console */\nconsole.log("b");\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const d = res.record!.summary.dispositions;
    assert.equal(d.materiallyChanged, 0);
    assert.equal(d.new, 0);
  });
});
