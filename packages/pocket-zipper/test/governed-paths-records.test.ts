import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupRepos,
  configYaml,
  eslintConfig,
  exceptionYaml,
  NEXT_LINE_NO_CONSOLE_FP,
  PROTECTED_CONFIG,
  PROTECTED_REGISTRY,
  repo,
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";

after(cleanupRepos);

const SUPPRESSION = "// eslint-disable-next-line no-console\nconsole.log(x);\n";

/** A repo governing `src/` with an exception record pointing at ungoverned `legacy/leg.js`. */
function orphanedRecordRepo(): FixtureRepo {
  const r = repo();
  r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
  r.write(PROTECTED_CONFIG, configYaml({ governedPaths: ["src/"] }));
  r.write(
    PROTECTED_REGISTRY,
    exceptionYaml({
      rule: "no-console",
      suppressionType: "next-line",
      fingerprint: NEXT_LINE_NO_CONSOLE_FP,
      file: "legacy/leg.js",
      type: "permanent",
    }),
  );
  r.write("legacy/leg.js", SUPPRESSION);
  r.write("src/gov.js", "export const g = 1;\n");
  r.commit("base");
  r.branch("base");
  return r;
}

describe("exception records stranded by a scope change", () => {
  it("validate reports an ungoverned record as spent with a delete-ready pointer, exit 0", () => {
    const r = orphanedRecordRepo();
    const res = r.runCli(["validate"], { json: false });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /outside the governed set/);
    assert.match(res.stdout, /spent/);
    assert.match(res.stdout, /entry 1 of 1/);
    assert.match(res.stdout, /\.pocket-zipper\/exceptions\.yml/);
  });

  it("check reports the same record as spent, never a gate failure", () => {
    const r = orphanedRecordRepo();
    r.write("src/gov.js", "export const g = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record!.summary.cleanup.spentExceptions, 1);
    assert.equal(res.record!.summary.cleanup.danglingExceptions, 0);
    assert.equal(res.record!.unused[0]!.status, "spent");
  });

  it("re-governing a path does not revive its records — they stay spent as existing debt", () => {
    const r = orphanedRecordRepo();
    // Widen the policy to govern legacy/ too, one merge earlier.
    r.write(PROTECTED_CONFIG, configYaml({ governedPaths: ["src/", "legacy/"] }));
    r.commit("widen");
    r.branch("widen");
    // A later change edits the formerly-ungoverned file, keeping the suppression.
    r.write("legacy/leg.js", `${SUPPRESSION}export const extra = 1;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "widen"]);
    assert.equal(res.status, 0);
    // The suppression is existing debt through the one-merge lag, so the record
    // is spent — not revived into use, not dangling.
    assert.equal(res.record!.summary.cleanup.spentExceptions, 1);
    assert.equal(res.record!.summary.cleanup.danglingExceptions, 0);
    assert.equal(res.record!.unused[0]!.status, "spent");
  });
});

describe("the wizard respects the governed set", () => {
  it("refuses to author a record for an ungoverned file", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ governedPaths: ["src/"] }));
    r.write("legacy/leg.js", "export const l = 1;\n");
    r.write("src/gov.js", "export const g = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("legacy/leg.js", `export const l = 1;\n${SUPPRESSION}`);
    const res = r.runCli(["exception", "add", "--from", "legacy/leg.js:2", "--reason", "r", "--reference", "#1"], { json: false });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no new debt at legacy\/leg\.js:2/);
  });

  it("still offers a governed file's new debt", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ governedPaths: ["src/"] }));
    r.write("legacy/leg.js", "export const l = 1;\n");
    r.write("src/gov.js", "export const g = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("src/gov.js", `export const g = 1;\n${SUPPRESSION}`);
    const res = r.runCli(["exception", "add", "--from", "src/gov.js:2", "--reason", "r", "--reference", "#1"], { json: false });
    assert.equal(res.status, 0);
    assert.match(r.read(PROTECTED_REGISTRY), /file: src\/gov\.js/);
  });
});
