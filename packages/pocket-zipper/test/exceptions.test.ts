import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRepo,
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

describe("the exception registry, resolved against the baseline", () => {
  it("authorizes exactly one logical suppression", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/exceptions.yml", baseRecord());
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
    assert.equal(res.record?.exceptions[0]?.status, "used");
  });

  it("does not authorize a suppression on a different rule", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(
      ".pocket-zipper/exceptions.yml",
      baseRecord({ rule: "no-debugger", fingerprint: NEXT_LINE_NO_DEBUGGER_FP }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    assert.equal(res.record?.summary.cleanup.danglingExceptions, 1);
  });

  it("does not let an exception in the same change authorize anything", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-zipper/exceptions.yml", baseRecord());
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
    r.write(".pocket-zipper/exceptions.yml", baseRecord({ file: "other.js" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
  });

  it("does not spend a record on an existing suppression in another file", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/exceptions.yml", baseRecord());
    r.write("app.js", "export const a = 1;\n");
    r.write("legacy.js", `${disabled}console.log("legacy");\n`);
    r.commit("base");
    r.branch("base");
    r.write("legacy.js", `${disabled}console.log("legacy");\nexport const tail = 1;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(
      res.record?.inventory.find((e) => e.file === "legacy.js")?.disposition,
      "existing",
    );
    assert.equal(res.record?.summary.cleanup.danglingExceptions, 1);
    assert.equal(res.record?.summary.cleanup.spentExceptions, 0);
    assert.equal(res.record?.exceptions[0]?.status, "dangling");
  });

  it("does not spend a record when another file's matching suppression merely moved", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/exceptions.yml", baseRecord());
    r.write("app.js", "export const a = 1;\n");
    r.write("legacy.js", `export const l = 1;\n${disabled}console.log("legacy");\n`);
    r.commit("base");
    r.branch("base");
    r.write(
      "legacy.js",
      `export const l = 1;\nexport const m = 2;\n${disabled}console.log("legacy");\n`,
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(
      res.record?.inventory.find((e) => e.file === "legacy.js")?.disposition,
      "moved-existing",
    );
    assert.equal(res.record?.summary.cleanup.danglingExceptions, 1);
    assert.equal(res.record?.summary.cleanup.spentExceptions, 0);
    assert.equal(res.record?.exceptions[0]?.status, "dangling");
  });

  it("fails closed on a malformed registry", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/exceptions.yml", "- rule: no-console\n  type: temporary\n");
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
  });

  it("proceeds with enforcement when the registry is empty", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/exceptions.yml", "");
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
  });

  it("proceeds with enforcement when no registry file exists", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
  });

  it("treats a renewal in the same change as a fresh authorization", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/exceptions.yml", baseRecord({ expires: "2000-01-01" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-zipper/exceptions.yml", baseRecord({ expires: "2099-01-01" }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 0);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    assert.equal(res.record?.summary.cleanup.expiredExceptions, 1);
  });

  it("treats temporary-to-permanent in the same change as a fresh authorization", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/exceptions.yml", baseRecord({ expires: "2000-01-01" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      ".pocket-zipper/exceptions.yml",
      baseRecord({ type: "permanent", expires: undefined }),
    );
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 0);
  });

  it("fails closed on invalid record fields", () => {
    const valid = `- rule: no-console\n  suppression_type: next-line\n  fingerprint: ${NEXT_LINE_NO_CONSOLE_FP}\n  file: app.js\n  type: permanent\n  reason: r\n  owner: o\n  reference: ref\n`;
    const without = (line: string) => valid.replace(line, "");
    const cases: Array<{ name: string; yaml: string; field: RegExp }> = [
      { name: "invalid type", yaml: valid.replace("type: permanent", "type: whenever"), field: /type/ },
      {
        name: "temporary without expires",
        yaml: valid.replace("type: permanent", "type: temporary"),
        field: /expires/,
      },
      {
        name: "non-exceptable config-off type",
        yaml: valid.replace("suppression_type: next-line", "suppression_type: config-off"),
        field: /suppression_type/,
      },
      { name: "permanent with expires", yaml: valid + "  expires: 2099-01-01\n", field: /expires/ },
      { name: "missing reason", yaml: without("  reason: r\n"), field: /reason/ },
      { name: "missing owner", yaml: without("  owner: o\n"), field: /owner/ },
      { name: "missing reference", yaml: without("  reference: ref\n"), field: /reference/ },
      {
        name: "invalid expires date",
        yaml: valid.replace("type: permanent", "type: temporary") + "  expires: not-a-date\n",
        field: /expires/,
      },
    ];
    for (const c of cases) {
      const r = repo();
      r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
      r.write(".pocket-zipper/exceptions.yml", c.yaml);
      r.write("app.js", "export const a = 1;\n");
      r.commit("base");
      r.branch("base");
      const res = r.runCli(["check", "--base", "base"]);
      assert.equal(res.status, 2, c.name);
      assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR", c.name);
      assert.match(res.record?.errors[0]?.message ?? "", c.field, c.name);
    }
  });
});
