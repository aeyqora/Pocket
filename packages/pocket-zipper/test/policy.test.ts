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
    assert.deepEqual(res.record?.summary.policy, { enabled: true, allowlist: null });
    assert.deepEqual(res.record?.summary.governedRules, ["no-console"]);
  });

  it("exits 0 with a minimal excluded record when enabled is false", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: false }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.verdict, "excluded");
    assert.deepEqual(res.record?.inventory, []);
    assert.deepEqual(res.record?.summary.policy, { enabled: false, allowlist: null });
    assert.deepEqual(res.record?.summary.governedRules, []);
  });

  it("makes ungoverned rules invisible to the gate", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.new, 0);
    assert.deepEqual(res.record?.summary.policy, {
      enabled: true,
      allowlist: ["no-debugger"],
    });
    assert.deepEqual(res.record?.summary.governedRules, ["no-debugger"]);
  });

  it("accepts a recognized-but-inapplicable forward-declared rule", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-var"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.summary.governedRules, []);
  });

  it("accepts a plugin rule the loaded config declares", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      [
        'const plugin = { rules: { "no-autofocus": {} } };',
        "export default [",
        '  { plugins: { "jsx-a11y": plugin }, rules: { "no-console": "error" } },',
        "];",
        "",
      ].join("\n"),
    );
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["jsx-a11y/no-autofocus"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.verdict, "pass");
  });

  it("fails closed on a mistyped plugin rule", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      [
        'const plugin = { rules: { "no-autofocus": {} } };',
        "export default [",
        '  { plugins: { "jsx-a11y": plugin }, rules: { "no-console": "error" } },',
        "];",
        "",
      ].join("\n"),
    );
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["jsx-a11y/no-autofocuss"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
  });

  it("fails closed on an unrecognized allowlist rule", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-such-rule-xyz"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
  });
});

describe("config-level off recognition", () => {
  it("records a newly added config-level off as a policy change, not debt", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const entry = res.record?.inventory.find((e) => e.disposition === "new");
    assert.equal(entry?.guardKind, "config-level");
    assert.equal(entry?.suppressionType, "config-off");
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    assert.ok(res.record?.errors.some((e) => e.code === "POLICY_CHANGE"));
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

  it("counts one config-level off however many files its pattern matches", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-debugger": "error" }));
    for (const f of ["src/a.js", "src/b.js", "src/c.js"]) {
      r.write(f, "export const a = 1;\n");
    }
    r.commit("base");
    r.branch("base");
    r.write(
      "eslint.config.mjs",
      [
        "export default [",
        '  { rules: { "no-debugger": "error" } },',
        '  { files: ["src/**"], rules: { "no-console": "off" } },',
        "];",
        "",
      ].join("\n"),
    );
    for (const f of ["src/a.js", "src/b.js", "src/c.js"]) {
      r.write(f, "export const a = 2;\n");
    }
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const configOffs = res.record?.inventory.filter((e) => e.guardKind === "config-level");
    assert.equal(configOffs?.length, 1);
    assert.equal(res.record?.summary.dispositions.new, 1);
  });

  it("does not count a config-level off an equal-scope declaration re-enables", () => {
    const r = repo();
    const config = [
      "export default [",
      '  { files: ["test/**"], rules: { "no-console": "off" } },',
      '  { files: ["test/**"], rules: { "no-console": "error" } },',
      "];",
      "",
    ].join("\n");
    r.write("eslint.config.mjs", config);
    r.write("test/a.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("test/a.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.inventory.length, 0);
  });

  it("keeps a global off that a narrower override only partially re-enables", () => {
    const r = repo();
    const config = [
      "export default [",
      '  { rules: { "no-console": "off" } },',
      '  { files: ["src/special/**"], rules: { "no-console": "error" } },',
      "];",
      "",
    ].join("\n");
    r.write("eslint.config.mjs", config);
    r.write("src/a.js", "export const a = 1;\n");
    r.write("src/special/b.js", "export const b = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("src/a.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const configOffs = res.record?.inventory.filter((e) => e.guardKind === "config-level");
    assert.equal(configOffs?.length, 1);
    assert.equal(configOffs?.[0]?.disposition, "existing");
  });

  it("does not hide debt on a partially-overridden off", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      [
        "export default [",
        '  { files: ["src/**"], rules: { "no-console": "off" } },',
        '  { files: ["src/*.js"], rules: { "no-console": "error" } },',
        "];",
        "",
      ].join("\n"),
    );
    r.write("src/a.js", "export const a = 1;\n");
    r.write("src/sub/b.js", "export const b = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("src/a.js", "export const a = 2;\n");
    r.write("src/sub/b.js", "export const b = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const configOffs = res.record?.inventory.filter((e) => e.guardKind === "config-level");
    assert.equal(configOffs?.length, 1);
    assert.equal(configOffs?.[0]?.disposition, "existing");
  });

  it("keeps config-off continuity when the declaration is reordered", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      'export default [{ rules: { "no-console": "off", "no-debugger": "error" } }];\n',
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      "eslint.config.mjs",
      [
        "export default [",
        '  { rules: { "no-debugger": "error" } },',
        '  { rules: { "no-console": "off" } },',
        "];",
        "",
      ].join("\n"),
    );
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const configOffs = res.record?.inventory.filter((e) => e.guardKind === "config-level");
    assert.equal(configOffs?.length, 1);
    assert.equal(configOffs?.[0]?.disposition, "existing");
  });

  it("fails closed when the registry tries to except a config-level off", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      ".pocket-zipper/exceptions.yml",
      [
        "- rule: no-console",
        "  suppression_type: config-off",
        `  fingerprint: v1:sha256:${"0".repeat(64)}`,
        "  file: eslint.config.mjs",
        "  type: permanent",
        "  reason: r",
        "  owner: o",
        "  reference: ref",
        "",
      ].join("\n"),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
  });
});

describe("governed set details", () => {
  it("keeps only the governed rule of a mixed multi-rule directive", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("base");
    r.branch("base");
    r.write(
      "app.js",
      `${disabled}console.log(1);\n// eslint-disable-next-line no-console, no-debugger\nfoo();\n`,
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.dispositions.new, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    assert.deepEqual(
      res.record?.inventory.map((e) => e.rule),
      ["no-debugger"],
    );
  });

  it("expands a broad directive to governed rules only", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${disabled}console.log(1);\n/* eslint-disable */\nfoo();\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.dispositions.new, 1);
    assert.deepEqual(
      res.record?.inventory.map((e) => e.rule),
      ["no-debugger"],
    );
  });
});

describe("the effective policy is baseline-authoritative", () => {
  it("does not let a head-side allowlist shape the current evaluation", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.deepEqual(res.record?.summary.policy, { enabled: true, allowlist: null });
    const newRules = res.record?.inventory
      .filter((e) => e.disposition === "new")
      .map((e) => e.rule);
    assert.deepEqual(newRules, ["no-console"]);
    assert.deepEqual(res.record?.summary.governedRules, ["no-console", "no-debugger"]);
  });

  it("evaluates the enablement flip under the old policy, then grandfathers it", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: false }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("A");
    r.branch("baseA");
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.commit("B");
    r.branch("baseB");

    const flip = r.runCli(["check", "--base", "baseA"]);
    assert.equal(flip.status, 0);
    assert.equal(flip.record?.verdict, "excluded");
    assert.deepEqual(flip.record?.summary.policy, { enabled: false, allowlist: null });

    r.write("app.js", `${disabled}console.log(1);\nconst b = 2;\n`);
    r.commit("C");
    const next = r.runCli(["check", "--base", "baseB"]);
    assert.equal(next.status, 0);
    assert.ok((next.record?.summary.dispositions.existing ?? 0) >= 1);
    assert.equal(next.record?.summary.dispositions.new, 0);
  });

  it("evaluates the allowlist widening under the old policy, then grandfathers it", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("A");
    r.branch("baseA");
    r.write(
      ".pocket-zipper/config.yml",
      configYaml({ governedRules: ["no-debugger", "no-console"] }),
    );
    r.write("app.js", `${disabled}console.log(1);\nconst b = 2;\n`);
    r.commit("B");
    r.branch("baseB");

    const widen = r.runCli(["check", "--base", "baseA"]);
    assert.equal(widen.status, 0);
    assert.deepEqual(widen.record?.summary.governedRules, ["no-debugger"]);
    assert.equal(widen.record?.summary.dispositions.new, 0);

    r.write("app.js", `${disabled}console.log(1);\nconst b = 2;\nconst c = 3;\n`);
    r.commit("C");
    const next = r.runCli(["check", "--base", "baseB"]);
    assert.equal(next.status, 0);
    assert.deepEqual(next.record?.summary.governedRules, ["no-console", "no-debugger"]);
    assert.ok((next.record?.summary.dispositions.existing ?? 0) >= 1);
    assert.equal(next.record?.summary.dispositions.new, 0);
  });

  it("skips policy validation entirely when disabled", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      ".pocket-zipper/config.yml",
      "enabled: false\ngovernedRules: [no-such-rule-xyz]\n",
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.verdict, "excluded");
    assert.deepEqual(res.record?.errors, []);
  });
});
