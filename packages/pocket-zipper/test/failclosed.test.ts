import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  configYaml,
  eslintConfig,
  repo,
  cleanupRepos,
  PROTECTED_CONFIG,
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";

after(cleanupRepos);

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
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.tool.name, "pocket-zipper");
    assert.equal(record.mode, "check");
    assert.equal(record.verdict, "pass");
    assert.match(record.baseline.tree, /^[0-9a-f]{40}$/);
    assert.match(record.proposedChange.tree, /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(record.inventory));
    assert.ok(Array.isArray(record.exceptions));
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
