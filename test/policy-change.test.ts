import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRepo,
  configYaml,
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
});
