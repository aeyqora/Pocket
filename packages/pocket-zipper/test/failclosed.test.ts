import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  configYaml,
  eslintConfig,
  repo,
  cleanupRepos,
  PROTECTED_CONFIG,
  PROTECTED_REGISTRY,
  exceptionYaml,
  hasErrorCode,
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";

after(cleanupRepos);

const validRepairRecord = exceptionYaml({
  rule: "no-console",
  suppressionType: "next-line",
  fingerprint: "v1:sha256:aa3906bd4b359e41c41625a924d3d3bbe95138e721f89cd87cd38839056a0f3e",
  file: "app.js",
  type: "permanent",
});

function malformedRegistry(fingerprint: string): string {
  return `- rule: no-console
  suppression_type: next-line
  fingerprint: ${fingerprint}
  file: app.js
  type: permanent
  reason: needed
`;
}

describe("fail-closed posture", () => {
  it("fails closed with GIT_ERROR when there is no merge-base", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("main");
    r.git(["checkout", "-q", "--orphan", "orphan"]);
    r.git(["rm", "-rf", "."]);
    r.write("app.js", "export const b = 2;\n");
    r.commit("orphan");
    const res = r.runCli(["check", "--base", "main"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "GIT_ERROR");
    assert.match(res.record?.errors[0]?.message ?? "", /pinned base/i);
  });

  it("fails closed with CONFIG_ERROR on malformed policy", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, "enabled: [not, a, boolean]\n");
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
  });

  it("keeps an unrelated change blocked by a poisoned baseline registry", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, malformedRegistry("bad-baseline"));
    r.write("app.js", "export const a = 1;\n");
    r.commit("poison baseline");
    r.branch("base");
    r.write("app.js", "export const a = 2;\n");
    r.commit("unrelated change");

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
    assert.match(res.record?.errors[0]?.message ?? "", /entry 1.*fingerprint/);
  });

  it("allows a clean registry repair without authorizing its own debt", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, malformedRegistry("bad-baseline"));
    r.write("app.js", "export const a = 1;\n");
    r.commit("poison baseline");
    r.branch("base");
    r.write(PROTECTED_REGISTRY, validRepairRecord);
    r.commit("repair registry");

    const res = r.runCli(["check", "--base", "base", "--verbose"]);
    assert.equal(res.status, 0);
    assert.ok(hasErrorCode(res.record, "BASELINE_DEFECT"));
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.summary.newDebt.authorized, 0);
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    assert.match(res.stdout, /error\[BASELINE_DEFECT\].*entry 1.*fingerprint/);
    assert.match(
      res.record?.errors.find((error) => error.code === "BASELINE_DEFECT")?.message ?? "",
      /exceptions\.yml:\d+:\d+.*expected.*v1:sha256.*got bad-baseline/,
    );
    assert.match(res.stdout, /error\[POLICY_CHANGE\]/);
  });

  it("keeps a repair that deletes many records on the additive policy track", () => {
    const secondRecord = exceptionYaml({
      rule: "no-debugger",
      suppressionType: "next-line",
      fingerprint: "v1:sha256:61de84d29f5ac52d69962ac28ca6fd2641c241ba465381af1992868081eae6b5",
      file: "app.js",
      type: "permanent",
    });
    const thirdRecord = exceptionYaml({
      rule: "no-alert",
      suppressionType: "next-line",
      fingerprint: "v1:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      file: "app.js",
      type: "permanent",
    });
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, validRepairRecord + secondRecord + thirdRecord + malformedRegistry("bad"));
    r.write("app.js", "export const a = 1;\n");
    r.commit("poison baseline");
    r.branch("base");
    r.write(PROTECTED_REGISTRY, validRepairRecord);
    r.commit("repair and delete records");

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasErrorCode(res.record, "BASELINE_DEFECT"));
    assert.match(
      res.record?.errors.find((error) => error.code === "POLICY_CHANGE")?.message ?? "",
      /repaired/,
    );
  });

  it("reports an empty registry repair as a protected policy change", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, malformedRegistry("bad-baseline"));
    r.write("app.js", "export const a = 1;\n");
    r.commit("poison baseline");
    r.branch("base");
    r.write(PROTECTED_REGISTRY, "\n");
    r.commit("repair registry to empty");

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasErrorCode(res.record, "BASELINE_DEFECT"));
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });

  it("does not let a repaired registry authorize new debt in the same change", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ allowSameChangeExceptions: true, host: "github" }));
    r.write(PROTECTED_REGISTRY, malformedRegistry("bad-baseline"));
    r.write("app.js", "export const a = 1;\n");
    r.commit("poison baseline");
    r.branch("base");
    r.write(PROTECTED_REGISTRY, validRepairRecord);
    r.write("app.js", "export const a = 1;\n// eslint-disable-next-line no-console\nconsole.log(1);\n");
    r.commit("repair and add debt");

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "BASELINE_DEFECT"));
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.summary.newDebt.authorized, 0);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
  });

  it("keeps a poisoned baseline config fail-closed during repair", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, "enabled: [not, a, boolean]\n");
    r.write(PROTECTED_REGISTRY, "\n");
    r.write("app.js", "export const a = 1;\n");
    r.commit("poison config");
    r.branch("base");
    r.write(PROTECTED_CONFIG, "enabled: true\n");
    r.commit("repair config");

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
    assert.doesNotMatch(JSON.stringify(res.record?.errors), /BASELINE_DEFECT/);
  });

  it("reports head defects when both baseline and repaired registries are defective", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, malformedRegistry("bad-baseline"));
    r.write("app.js", "export const a = 1;\n");
    r.commit("poison baseline");
    r.branch("base");
    r.write(PROTECTED_REGISTRY, malformedRegistry("bad-head"));
    r.commit("failed repair");

    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
    assert.match(res.record?.errors[0]?.message ?? "", /bad-head/);
    assert.doesNotMatch(res.record?.errors[0]?.message ?? "", /bad-baseline/);
  });

  it("allows the same clean registry repair from the staged index", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, malformedRegistry("bad-baseline"));
    r.write("app.js", "export const a = 1;\n");
    r.commit("poison baseline");
    r.write(PROTECTED_REGISTRY, validRepairRecord);
    r.stage(PROTECTED_REGISTRY);

    const res = r.runCli(["pre-commit", "--verbose"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.mode, "pre-commit");
    assert.ok(hasErrorCode(res.record, "BASELINE_DEFECT"));
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    assert.match(res.stdout, /error\[BASELINE_DEFECT\]/);
  });

  it("evaluates nothing when disabled, even with a broken ESLint config", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      "export default (() => { throw new Error('config boom'); })();\n",
    );
    r.write(PROTECTED_CONFIG, configYaml({ enabled: false }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.verdict, "excluded");
  });

  it("fails closed with ESLINT_ERROR when ESLint cannot execute", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      "export default (() => { throw new Error('config boom'); })();\n",
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "ESLINT_ERROR");
  });
});

describe("evaluation record contract", () => {
  it("pins the schema-v1 shape and tree ids", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    const record = res.record!;
    assert.equal(record.schemaVersion, 4);
    assert.equal(record.tool.name, "pocket-zipper");
    assert.equal(record.mode, "check");
    assert.equal(record.verdict, "pass");
    assert.match(record.baseline.tree, /^[0-9a-f]{40}$/);
    assert.match(record.proposedChange.tree, /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(record.inventory));
    assert.ok(Array.isArray(record.exceptions));
    assert.ok(Array.isArray(record.unused));
    assert.ok(Array.isArray(record.errors));
  });

  it("emits a minimal excluded record for enabled: false", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: false }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    const res = r.runCli(["check", "--base", "main"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.verdict, "excluded");
    assert.deepEqual(res.record?.errors, []);
    assert.deepEqual(res.record?.inventory, []);
  });
});
