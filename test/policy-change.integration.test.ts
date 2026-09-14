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

describe("policy-change detection through the pipeline", () => {
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
});
