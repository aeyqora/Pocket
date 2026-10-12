import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupRepos,
  configYaml,
  eslintConfig,
  PROTECTED_CONFIG,
  repo,
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";

after(cleanupRepos);

/** A repo governing `src/` only; `legacy/` and everything else are ungoverned. */
function pathRepo(): FixtureRepo {
  const r = repo();
  r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
  r.write(PROTECTED_CONFIG, configYaml({ governedPaths: ["src/"] }));
  r.write("src/gov.js", "export const g = 1;\n");
  r.write("legacy/leg.js", "export const l = 1;\n");
  r.commit("base");
  r.branch("base");
  return r;
}

const SUPPRESSION = "// eslint-disable-next-line no-console\nconsole.log(x);\n";

describe("the gate under a governed-path allowlist", () => {
  it("new suppression debt in an ungoverned path is invisible in check", () => {
    const r = pathRepo();
    r.write("legacy/leg.js", `export const l = 1;\n${SUPPRESSION}`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record!.summary.dispositions.new, 0);
    assert.equal(res.record!.summary.dispositions.existing, 0);
  });

  it("the same debt in a governed path fails as today", () => {
    const r = pathRepo();
    r.write("src/gov.js", `export const g = 1;\n${SUPPRESSION}`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record!.summary.dispositions.new, 1);
  });

  it("new suppression debt in an ungoverned path is invisible in pre-commit", () => {
    const r = pathRepo();
    r.write("legacy/leg.js", `export const l = 1;\n${SUPPRESSION}`);
    r.stage();
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.equal(res.record!.summary.dispositions.new, 0);
  });

  it("an empty allowlist governs nothing, so new debt anywhere is invisible", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, "governedPaths: []\n");
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${SUPPRESSION}`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record!.summary.dispositions.new, 0);
  });
});

describe("overlap and subtraction", () => {
  it("overlap is legal and exclusion wins, end to end", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      PROTECTED_CONFIG,
      configYaml({ governedPaths: ["packages/"], ungovernedPaths: ["packages/legacy/"] }),
    );
    r.write("packages/core/c.js", "export const c = 1;\n");
    r.write("packages/legacy/leg.js", "export const l = 1;\n");
    r.commit("base");
    r.branch("base");
    // Both keys claim packages/legacy/; the subtractor wins, so its debt is
    // invisible while a governed package still fails.
    r.write("packages/legacy/leg.js", `export const l = 1;\n${SUPPRESSION}`);
    r.write("packages/core/c.js", `export const c = 1;\n${SUPPRESSION}`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record!.summary.dispositions.new, 1);
    // The ungoverned suppression is absent from the inventory entirely.
    assert.equal(res.record!.inventory.filter((e) => e.file === "packages/legacy/leg.js").length, 0);
  });

  it("a forward-declared subtractor entry outside the governed set is legal and silent", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      PROTECTED_CONFIG,
      configYaml({ governedPaths: ["src/"], ungovernedPaths: ["packages/legacy/"] }),
    );
    r.write("src/gov.js", "export const g = 1;\n");
    r.write("packages/legacy/leg.js", "export const l = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record!.errors, []);
  });
});

describe("the record publishes the effective path lists", () => {
  it("publishes parsed, sorted lists and schema version 4", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      PROTECTED_CONFIG,
      configYaml({
        governedPaths: ["src/", "packages/"],
        ungovernedPaths: ["packages/legacy/"],
      }),
    );
    r.write("src/gov.js", "export const g = 1;\n");
    r.write("packages/legacy/leg.js", "export const l = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("src/gov.js", "export const g = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.record!.schemaVersion, 4);
    assert.deepEqual(res.record!.summary.governedPaths, ["packages/", "src/"]);
    assert.deepEqual(res.record!.summary.ungovernedPaths, ["packages/legacy/"]);
  });

  it("publishes null lists when both keys are absent", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.record!.summary.governedPaths, null);
    assert.equal(res.record!.summary.ungovernedPaths, null);
  });
});
