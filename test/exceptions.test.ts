import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRepo,
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

function baseRecord(overrides: Partial<Parameters<typeof exceptionYaml>[0]> = {}) {
  return exceptionYaml({
    rule: "no-console",
    suppressionType: "next-line",
    fingerprint: NEXT_LINE_NO_CONSOLE_FP,
    file: "app.js",
    type: "temporary",
    expires: "2099-01-01",
    ...overrides,
  });
}

describe("the exception registry", () => {
  it("authorizes exactly one logical suppression", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/exceptions.yml", baseRecord());
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    const entry = res.record?.inventory.find((e) => e.disposition === "new");
    assert.equal(entry?.exception?.fingerprint, NEXT_LINE_NO_CONSOLE_FP);
  });

  it("supports permanent records with no expiry", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      ".pocket-lock/exceptions.yml",
      baseRecord({ type: "permanent", expires: undefined }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
  });

  it("stops authorizing once expired and surfaces it distinctly", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/exceptions.yml", baseRecord({ expires: "2000-01-01" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    assert.equal(res.record?.summary.cleanup.expiredExceptions, 1);
  });

  it("reports a dangling exception as cleanup debt without failing the gate", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/exceptions.yml", baseRecord());
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.cleanup.danglingExceptions, 1);
  });

  it("reports a spent exception when its suppression became existing debt", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/exceptions.yml", baseRecord());
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${disabled}console.log(1);\nconst b = 2;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.cleanup.spentExceptions, 1);
    assert.equal(res.record?.exceptions[0]?.status, "spent");
  });

  it("does not let an exception in the same change authorize anything", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-lock/exceptions.yml", baseRecord());
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 0);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
  });

  it("fails closed when the record's file does not match the suppression", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/exceptions.yml", baseRecord({ file: "other.js" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
  });

  it("fails closed on a malformed registry", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-lock/exceptions.yml", "- rule: no-console\n  type: temporary\n");
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
  });
});
