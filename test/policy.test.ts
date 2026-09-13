import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRepo, configYaml, eslintConfig, type FixtureRepo } from "./harness.js";

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

function repo(): FixtureRepo {
  const r = createRepo();
  repos.push(r);
  return r;
}

const disabled = "// eslint-disable-next-line no-console\n";

describe("governed scope and lock enablement", () => {
  it("governs every applicable rule when no policy file exists", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.deepEqual(res.record?.summary.governedRules, ["no-console"]);
  });

  it("exits 0 with a minimal excluded record when enabled is false", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ enabled: false }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.verdict, "excluded");
    assert.deepEqual(res.record?.inventory, []);
    assert.deepEqual(res.record?.summary.governedRules, []);
  });

  it("makes ungoverned rules invisible to the gate", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(".pocket-lock/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.new, 0);
    assert.deepEqual(res.record?.summary.governedRules, ["no-debugger"]);
  });

  it("accepts a recognized-but-inapplicable forward-declared rule", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ governedRules: ["no-var"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.summary.governedRules, []);
  });

  it("accepts a plugin-scoped allowlist rule that ESLint cannot verify as core", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ governedRules: ["jsx-a11y/no-autofocus"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.verdict, "pass");
  });

  it("fails closed on an unrecognized allowlist rule", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ governedRules: ["no-such-rule-xyz"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
  });
});

describe("config-level off recognition", () => {
  it("counts a newly added config-level off as new debt", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    const entry = res.record?.inventory.find((e) => e.disposition === "new");
    assert.equal(entry?.guardKind, "config-level");
    assert.equal(entry?.suppressionType, "config-off");
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
  });

  it("reconciles a pre-existing config-level off as existing debt", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.existing, 1);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });

  it("counts deleting a config-level off as removed", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.removed, 1);
  });
});
