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

/** A repo governing `src/` only, with an ungoverned suppression already present in `legacy/`. */
function ungovernedBaseline(): FixtureRepo {
  const r = repo();
  r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
  r.write(PROTECTED_CONFIG, configYaml({ governedPaths: ["src/"] }));
  r.write("legacy/a.js", SUPPRESSION);
  r.write("src/b.js", "export const b = 1;\n");
  r.commit("base");
  r.branch("base");
  return r;
}

describe("baseline continuity honors the governed set", () => {
  it("a suppression moved ungoverned→governed reads new debt, not a continuity twin", () => {
    const r = ungovernedBaseline();
    r.write("legacy/a.js", "console.log(x);\n"); // the ungoverned suppression is gone
    r.write("src/b.js", `export const b = 1;\n${SUPPRESSION}`); // the same directive, governed now
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record!.summary.dispositions.new, 1);
    assert.equal(res.record!.summary.dispositions.movedExisting, 0);
  });

  it("the same move passes with an exception, like any new debt", () => {
    const r = ungovernedBaseline();
    // The baseline registry already excepts the head-side governed suppression.
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "src/b.js",
        type: "permanent",
      }),
    );
    r.commit("base2");
    r.branch("base2");
    r.write("legacy/a.js", "console.log(x);\n");
    r.write("src/b.js", `export const b = 1;\n${SUPPRESSION}`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base2"]);
    assert.equal(res.status, 0);
    assert.equal(res.record!.summary.newDebt.authorized, 1);
    assert.equal(res.record!.summary.newDebt.unauthorized, 0);
  });

  it("a git-reported rename ungoverned→governed reads new debt", () => {
    const r = ungovernedBaseline();
    r.git(["mv", "legacy/a.js", "src/a.js"]);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record!.summary.dispositions.new, 1);
    assert.equal(res.record!.summary.dispositions.movedExisting, 0);
  });

  it("a removal in an ungoverned path produces no removed disposition", () => {
    const r = ungovernedBaseline();
    r.write("legacy/a.js", "console.log(x);\n"); // the ungoverned suppression is deleted
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record!.summary.dispositions.removed, 0);
  });

  it("continuity inside a governed path is unchanged", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ governedPaths: ["src/"] }));
    r.write("src/gate.js", SUPPRESSION);
    r.commit("base");
    r.branch("base");
    // An in-place rewrite of the guarded statement is existing debt, not new.
    r.write("src/gate.js", "// eslint-disable-next-line no-console\nconsole.log(y);\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record!.summary.dispositions.existing, 1);
    assert.equal(res.record!.summary.dispositions.new, 0);
  });
});

describe("the tomb walk skips ungoverned paths", () => {
  it("does not mistake an ungoverned file's content for a dead twin's home", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ governedPaths: ["src/"] }));
    r.write(
      "src/gate.js",
      "work();\n// eslint-disable-next-line no-console\nconsole.log(\"dead\");\n",
    );
    // An ungoverned file carries the same guarded text as the governed twin.
    r.write("legacy/backup.js", "console.log(\"dead\");\n");
    r.commit("base");
    r.branch("base");
    // The governed suppression becomes a tomb: the comment moves, the twin's
    // guarded statement is removed, and a newborn statement replaces it.
    r.write(
      "src/gate.js",
      "work();\nend();\n// eslint-disable-next-line no-console\nconsole.log(\"brand-new\");\n",
    );
    // The ungoverned file still carries the dead text — the tomb walk must skip
    // it, or the dead twin would appear to survive.
    r.write("legacy/backup.js", "console.log(\"dead\");\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record!.summary.dispositions.materiallyChanged, 1);
    assert.equal(res.record!.summary.dispositions.new, 0);
  });
});
