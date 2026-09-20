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

describe("recognition and the first gate verdict", () => {
  it("passes an empty diff by construction", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.verdict, "pass");
    assert.deepEqual(res.record?.summary.dispositions, {
      existing: 0,
      movedExisting: 0,
      removed: 0,
      new: 0,
      materiallyChanged: 0,
    });
  });

  it("fails a newly added governed suppression with remediation", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n\n${disabled}console.log(1);\n`);
    r.commit("add");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.verdict, "fail");
    assert.equal(res.record?.summary.dispositions.new, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    const entry = res.record?.inventory.find((e) => e.disposition === "new");
    assert.equal(entry?.rule, "no-console");
    assert.equal(entry?.suppressionType, "next-line");
    assert.equal(entry?.guardKind, "directive");
    assert.match(res.stdout, /app\.js:\d+/);
    assert.match(res.stdout, /suppression_type: next-line/);
    assert.match(res.stdout, /fingerprint: v1:sha256:/);
  });

  it("always passes when suppression debt is deleted", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", `a();\n${disabled}console.log(1);\nb();\n${disabled}console.log(2);\n`);
    r.commit("base");
    r.branch("base");
    r.write("app.js", `a();\n${disabled}console.log(1);\nb();\n`);
    r.commit("delete");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.removed, 1);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });

  it("expands a multi-rule directive to one logical suppression per rule", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "// eslint-disable-next-line no-console, no-debugger\nconsole.log(1);\n");
    r.commit("multi");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    const rules = res.record?.inventory
      .filter((e) => e.disposition === "new")
      .map((e) => e.rule)
      .sort();
    assert.deepEqual(rules, ["no-console", "no-debugger"]);
  });

  it("flags only the added rule token when a multi-rule directive grows", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("base");
    r.branch("base");
    r.write(
      "app.js",
      "// eslint-disable-next-line no-console, no-debugger\nconsole.log(1);\n",
    );
    r.commit("grow");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.dispositions.new, 1);
    assert.equal(res.record?.summary.dispositions.existing, 1);
    const added = res.record?.inventory.find((e) => e.disposition === "new");
    assert.equal(added?.rule, "no-debugger");
  });

  it("treats a directive naming a config-off rule as carrying no debt", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "off", "no-debugger": "error" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("unused-directive");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });
});
