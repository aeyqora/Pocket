import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRepo,
  configYaml,
  eslintConfig,
  hasErrorCode,
  type FixtureRepo,
} from "./harness.js";
import { EMPTY_TREE } from "../src/git.js";

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

const noConsole = "// eslint-disable-next-line no-console\n";
const noDebugger = "// eslint-disable-next-line no-debugger\n";

function repo(): FixtureRepo {
  const r = createRepo();
  repos.push(r);
  return r;
}

describe("documented onboarding path", () => {
  it("lands disabled, mass-suppresses, flips under the old policy, then narrows and widens", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: false }));
    r.write("app.js", `${noConsole}console.log(1);\n`);
    r.commit("land disabled");
    r.branch("land");

    r.write("app.js", `${noConsole}console.log(1);\n${noDebugger}debugger;\n`);
    r.commit("mass suppress");
    r.branch("mass");
    const massSuppress = r.runCli(["check", "--base", "land"]);
    assert.equal(massSuppress.status, 0);
    assert.equal(massSuppress.record?.verdict, "excluded");

    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.commit("flip");
    const flip = r.runCli(["check", "--base", "mass"]);
    assert.equal(flip.status, 0);
    assert.equal(flip.record?.verdict, "excluded");
    assert.equal(flip.record?.summary.policy.enabled, false);
    r.branch("flip");

    r.write("app.js", `${noConsole}console.log(1);\n${noDebugger}debugger;\nconst a = 1;\n`);
    r.commit("after flip");
    const after = r.runCli(["check", "--base", "flip"]);
    assert.equal(after.status, 0);
    assert.ok((after.record?.summary.dispositions.existing ?? 0) >= 2);
    assert.equal(after.record?.summary.dispositions.new, 0);
    r.branch("after");

    r.write(
      ".pocket-zipper/config.yml",
      configYaml({ enabled: true, governedRules: ["no-debugger"] }),
    );
    r.write("app.js", `${noConsole}console.log(1);\n${noDebugger}debugger;\nconst a = 2;\n`);
    r.commit("narrow allowlist");
    const narrow = r.runCli(["check", "--base", "after"]);
    assert.equal(narrow.status, 0);
    assert.ok(hasErrorCode(narrow.record, "POLICY_CHANGE"));
    r.branch("narrow");

    r.write(
      ".pocket-zipper/config.yml",
      configYaml({ enabled: true, governedRules: ["no-debugger", "no-console"] }),
    );
    r.write("app.js", `${noConsole}console.log(1);\n${noDebugger}debugger;\nconst a = 3;\n`);
    r.commit("widen allowlist");
    const widen = r.runCli(["check", "--base", "narrow"]);
    assert.equal(widen.status, 0);
    assert.deepEqual(widen.record?.summary.governedRules, ["no-debugger"]);
    r.branch("widen");

    r.write(
      "app.js",
      `${noConsole}console.log(1);\n${noDebugger}debugger;\nconst a = 3;\n${noConsole}console.log(2);\n`,
    );
    r.commit("new debt");
    const newDebt = r.runCli(["check", "--base", "widen"]);
    assert.equal(newDebt.status, 1);
    assert.equal(newDebt.record?.summary.newDebt.unauthorized, 1);
  });

  it("smoke-tests a fresh repo: a staged first commit with a governed suppression fails", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", `${noConsole}console.log(1);\n`);
    r.stage();
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.baseline.tree, EMPTY_TREE);
    assert.equal(res.record?.summary.dispositions.new, 1);
  });
});
