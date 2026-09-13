import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRepo,
  configYaml,
  eslintConfig,
  exceptionYaml,
  NEXT_LINE_NO_CONSOLE_FP,
  NEXT_LINE_NO_DEBUGGER_FP,
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
const noDebugger = "// eslint-disable-next-line no-debugger\n";

function hasPolicyChange(record: { errors: Array<{ code: string }> } | null): boolean {
  return record?.errors.some((e) => e.code === "POLICY_CHANGE") ?? false;
}

describe("policy-change detection", () => {
  it("fails when a weakening edit is consumed by new debt in the same change", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-lock/config.yml", configYaml({ enabled: false }));
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasPolicyChange(res.record));
  });

  it("records but does not fail a pure weakening edit", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-lock/config.yml", configYaml({ enabled: false }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasPolicyChange(res.record));
  });

  it("does not fire on a policy strengthening", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      ".pocket-lock/config.yml",
      configYaml({ governedRules: ["no-debugger", "no-console"] }),
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasPolicyChange(res.record), false);
  });

  it("records a lone exception addition as a pure policy edit", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      ".pocket-lock/exceptions.yml",
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasPolicyChange(res.record));
  });

  it("records removal of an explicitly-true enabled key as weakening", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    // Drop the `enabled` key entirely.
    r.write(".pocket-lock/config.yml", "# policy unchanged beyond removing the flag\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasPolicyChange(res.record));
  });

  it("fails when removal of an explicitly-true enabled key is consumed", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-lock/config.yml", "# policy unchanged beyond removing the flag\n");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasPolicyChange(res.record));
  });

  it("does not fire when no protected file is touched", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(hasPolicyChange(res.record), false);
  });

  it("fires even when the consumed debt is authorized by an exception", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ enabled: true }));
    r.write(
      ".pocket-lock/exceptions.yml",
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-lock/config.yml", configYaml({ enabled: false }));
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasPolicyChange(res.record));
    assert.equal(res.record?.summary.newDebt.authorized, 1);
  });

  it("fails a membership loss consumed even when the debt is authorized", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(
      ".pocket-lock/config.yml",
      configYaml({ governedRules: ["no-console", "no-debugger"] }),
    );
    r.write(
      ".pocket-lock/exceptions.yml",
      exceptionYaml({
        rule: "no-debugger",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-lock/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", `export const a = 1;\n${noDebugger}\ndebugger;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
    assert.ok(hasPolicyChange(res.record));
  });

  it("fails an absent-to-narrower allowlist consumed even when the debt is authorized", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(
      ".pocket-lock/exceptions.yml",
      exceptionYaml({
        rule: "no-debugger",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-lock/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", `export const a = 1;\n${noDebugger}\ndebugger;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
    assert.ok(hasPolicyChange(res.record));
  });

  it("does not fire when a new allowlist still covers every governed rule", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-debugger": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-lock/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasPolicyChange(res.record), false);
  });

  it("fires when the exception registry broadens and is consumed", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      ".pocket-lock/exceptions.yml",
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasPolicyChange(res.record));
  });

  it("fires when a record's identity-critical field changes and is consumed", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(".pocket-lock/config.yml", configYaml({ enabled: true }));
    r.write(
      ".pocket-lock/exceptions.yml",
      exceptionYaml({
        rule: "no-debugger",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      ".pocket-lock/exceptions.yml",
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasPolicyChange(res.record));
  });

  it("stays silent when only non-identity registry fields change", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/config.yml", configYaml({ enabled: true }));
    r.write(
      ".pocket-lock/exceptions.yml",
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      ".pocket-lock/exceptions.yml",
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: "2098-01-01",
      }),
    );
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasPolicyChange(res.record), false);
  });

  it("ignores order and formatting changes to the allowlist", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(
      ".pocket-lock/config.yml",
      configYaml({ governedRules: ["no-console", "no-debugger"] }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      ".pocket-lock/config.yml",
      "governedRules:\n  - 'no-debugger'\n  - \"no-console\"\n",
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasPolicyChange(res.record), false);
  });

  it("records a membership loss without consumption as a pure policy edit", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(
      ".pocket-lock/config.yml",
      configYaml({ governedRules: ["no-console", "no-debugger"] }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-lock/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasPolicyChange(res.record));
  });
});
