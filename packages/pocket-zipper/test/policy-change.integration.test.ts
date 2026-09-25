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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: false }));
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasPolicyChange(res.record));
  });

  it("fails when removal of an explicitly-true enabled key is consumed", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-zipper/config.yml", "# policy unchanged beyond removing the flag\n");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasPolicyChange(res.record));
  });

  it("does not fire when no protected file is touched", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write(
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: false }));
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
      ".pocket-zipper/config.yml",
      configYaml({ governedRules: ["no-console", "no-debugger"] }),
    );
    r.write(
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-debugger"] }));
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
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-debugger"] }));
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      ".pocket-zipper/exceptions.yml",
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

  it("does not fire when an appended record is a twin of one the registry already has", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.write(
      ".pocket-zipper/exceptions.yml",
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        type: "permanent",
        line: 2,
      }),
    );
    r.commit("base");
    r.branch("base");
    // The appended record is a twin: the same match key, distinct only in the
    // line a reader is helped by — which is not a match input. The authorized
    // *set* of match keys has not grown, so this is a second record for debt the
    // registry already permitted, not a widening of what it permits. Had
    // broadening compared records rather than keys, this would read as a
    // weakening and the same change would fail.
    r.write(
      ".pocket-zipper/exceptions.yml",
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        type: "permanent",
        line: 2,
      }) +
        exceptionYaml({
          rule: "no-console",
          suppressionType: "next-line",
          fingerprint: NEXT_LINE_NO_CONSOLE_FP,
          file: "app.js",
          type: "permanent",
          line: 3,
        }),
    );
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasPolicyChange(res.record), false);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
  });

  it("fires when a record's identity-critical field changes and is consumed", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write(
      ".pocket-zipper/exceptions.yml",
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
      ".pocket-zipper/exceptions.yml",
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

describe("config-level severity weakenings as policy changes", () => {
  it("records a pure config-level off addition as a policy change that passes", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasPolicyChange(res.record));
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    assert.match(res.stdout, /PASS/);
    assert.match(res.stdout, /POLICY_CHANGE/);
  });

  it("fails when a config-level off weakening is consumed by new directive debt", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off", "no-debugger": "error" }));
    r.write("app.js", `${noDebugger}\ndebugger;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasPolicyChange(res.record));
    assert.equal(res.record?.verdict, "fail");
  });

  it("does not fire a policy change for an off of a rule the allowlist never governed", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off", "no-debugger": "error" }));
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasPolicyChange(res.record), false);
  });

  it("records an off that hides a same-change directive as a policy change, not debt", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off" }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasPolicyChange(res.record));
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
  });

  it("records lowering a governed rule from error to warn as a policy change that passes", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "warn" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasPolicyChange(res.record));
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    assert.match(res.stdout, /POLICY_CHANGE/);
  });

  it("does not fire for a warn-to-error strengthening", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "warn" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasPolicyChange(res.record), false);
  });

  it("fails when a severity drop is paired with new directive debt for the same rule", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "warn" }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasPolicyChange(res.record));
    assert.equal(res.record?.verdict, "fail");
  });

  it("fails when a warn drop is consumed by new debt for another governed rule", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "warn", "no-debugger": "error" }),
    );
    r.write("app.js", `${noDebugger}\ndebugger;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasPolicyChange(res.record));
    assert.equal(res.record?.verdict, "fail");
  });
});
