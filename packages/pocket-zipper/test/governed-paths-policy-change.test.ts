import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupRepos,
  configYaml,
  eslintConfig,
  hasErrorCode,
  PROTECTED_CONFIG,
  repo,
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";

after(cleanupRepos);

/** A flat config whose rule block is scoped to `files`, so its reach is exact. */
function scopedTo(rules: Record<string, string>, files: string[]): string {
  const body = Object.entries(rules)
    .map(([rule, sev]) => `    "${rule}": ${JSON.stringify(sev)}`)
    .join(",\n");
  return `export default [\n  {\n    files: ${JSON.stringify(files)},\n    rules: {\n${body}\n    },\n  },\n];\n`;
}

/** A repo governing `src/`; `legacy/` is ungoverned, and both carry a JS file. */
function pathScopedRepo(config: string): FixtureRepo {
  const r = repo();
  r.write("eslint.config.mjs", config);
  r.write(PROTECTED_CONFIG, configYaml({ governedPaths: ["src/"] }));
  r.write("src/gov.js", "export const g = 1;\n");
  r.write("legacy/leg.js", "export const l = 1;\n");
  r.commit("base");
  r.branch("base");
  return r;
}

describe("the policy track is scoped by config-block reach", () => {
  it("a config-only weakening in a block scoped entirely to ungoverned paths is invisible", () => {
    const r = pathScopedRepo(scopedTo({ "no-console": "error" }, ["legacy/**/*.js"]));
    r.write("eslint.config.mjs", scopedTo({ "no-console": "off" }, ["legacy/**/*.js"]));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), false);
  });

  it("the same weakening in a block whose reach intersects governed paths is recorded", () => {
    const r = pathScopedRepo(scopedTo({ "no-console": "error" }, ["src/**/*.js"]));
    r.write("eslint.config.mjs", scopedTo({ "no-console": "off" }, ["src/**/*.js"]));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), true);
  });

  it("an unscoped block's weakening signals whatever the governed set", () => {
    // The config file sits at the repository root, outside `src/` — its own path
    // never decides. The unscoped block reaches everything, so it is governed.
    const r = pathScopedRepo(eslintConfig({ "no-console": "error" }));
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), true);
  });

  it("a new config-off reaching only ungoverned paths counts nothing", () => {
    const r = pathScopedRepo(scopedTo({ "no-console": "error" }, ["legacy/**/*.js"]));
    r.write("eslint.config.mjs", scopedTo({ "no-console": "off" }, ["legacy/**/*.js"]));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    // The config-off inventory is reach-filtered too: no disposition arises.
    assert.equal(res.record!.summary.dispositions.new, 0);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), false);
  });

  it("a new config-off reaching governed paths counts once per scope", () => {
    const r = pathScopedRepo(scopedTo({ "no-console": "error" }, ["src/**/*.js"]));
    r.write("eslint.config.mjs", scopedTo({ "no-console": "off" }, ["src/**/*.js"]));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), true);
    assert.equal(res.record!.summary.dispositions.new, 1);
  });
});

describe("severity floors are scoped by config-block reach", () => {
  it("a floor violation scoped entirely to ungoverned paths is invisible", () => {
    const r = repo();
    r.write("eslint.config.mjs", scopedTo({ "no-console": "error" }, ["legacy/**/*.js"]));
    r.write(
      PROTECTED_CONFIG,
      configYaml({ governedPaths: ["src/"], minSeverities: { "no-console": "error" } }),
    );
    r.write("src/gov.js", "export const g = 1;\n");
    r.write("legacy/leg.js", "export const l = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", scopedTo({ "no-console": "off" }, ["legacy/**/*.js"]));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasErrorCode(res.record, "SEVERITY_FLOOR"), false);
  });

  it("a floor violation reaching governed paths fails as today", () => {
    const r = repo();
    r.write("eslint.config.mjs", scopedTo({ "no-console": "error" }, ["src/**/*.js"]));
    r.write(
      PROTECTED_CONFIG,
      configYaml({ governedPaths: ["src/"], minSeverities: { "no-console": "error" } }),
    );
    r.write("src/gov.js", "export const g = 1;\n");
    r.write("legacy/leg.js", "export const l = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", scopedTo({ "no-console": "off" }, ["src/**/*.js"]));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(hasErrorCode(res.record, "SEVERITY_FLOOR"), true);
  });
});
