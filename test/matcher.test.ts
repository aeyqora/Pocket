import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRepo, eslintConfig, type FixtureRepo } from "./harness.js";

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

function repo(): FixtureRepo {
  const r = createRepo();
  repos.push(r);
  return r;
}

const nc = "// eslint-disable-next-line no-console\n";
const nd = "// eslint-disable-next-line no-debugger\n";

describe("continuity matcher: recognition through to disposition", () => {
  it("1. reordered lines: pairs by guard context, not line number", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      "app.js",
      `foo();\n${nc}console.log("a");\nbar();\n${nc}console.log("b");\nbaz();\n`,
    );
    r.commit("base");
    r.branch("base");
    r.write(
      "app.js",
      `foo();\nbar();\n${nc}console.log("b");\nbaz();\n${nc}console.log("a");\n`,
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const d = res.record!.summary.dispositions;
    assert.equal(d.new, 0);
    assert.equal(d.movedExisting, 2);
    assert.equal(d.existing, 0);
    const byHeadLine = new Map(
      res.record!.inventory.map((e) => [e.lines.head, e.lines.baseline]),
    );
    // head's "b" (directive line 3) pairs with baseline's "b" (line 5); head's
    // "a" (line 6) with baseline's "a" (line 2) — by content, not proximity.
    assert.equal(byHeadLine.get(3), 5);
    assert.equal(byHeadLine.get(6), 2);
  });

  it("1b. a three-entry pool is allocated greedily by guard context", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      "app.js",
      `${nc}console.log("a");\nmid1();\n${nc}console.log("b");\nmid2();\n${nc}console.log("c");\n`,
    );
    r.commit("base");
    r.branch("base");
    r.write(
      "app.js",
      `${nc}console.log("c");\n${nc}console.log("b");\nmid1();\n${nc}console.log("a");\nmid2();\n`,
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const d = res.record!.summary.dispositions;
    assert.equal(d.new, 0);
    assert.equal(d.existing + d.movedExisting, 3);
    const byHeadLine = new Map(
      res.record!.inventory.map((e) => [e.lines.head, e.lines.baseline]),
    );
    // baseline directives: a@1, b@4, c@7; head directives: c@1, b@3, a@6.
    assert.equal(byHeadLine.get(1), 7);
    assert.equal(byHeadLine.get(3), 4);
    assert.equal(byHeadLine.get(6), 1);
  });

  it("4. file rename: git-recognized move carries as moved-existing", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("utils.js", `${nc}console.log(timestamp());\n`);
    r.commit("base");
    r.branch("base");
    r.mkdir("lib");
    r.git(["mv", "utils.js", "lib/utils.js"]);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const d = res.record!.summary.dispositions;
    assert.equal(d.new, 0);
    assert.equal(d.movedExisting, 1);
  });

  it("8. interleaved new suppression is not hidden by existing debt", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("flow.js", `${nc}console.log("legacy-1");\nwork();\n${nc}console.log("legacy-2");\nend();\n`);
    r.commit("base");
    r.branch("base");
    r.write(
      "flow.js",
      `${nc}console.log("legacy-1");\nwork();\n${nc}console.log("legacy-2");\nend();\nfeature();\n${nd}debugger;\n`,
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    const d = res.record!.summary.dispositions;
    assert.equal(d.existing, 2);
    assert.equal(d.new, 1);
    const added = res.record!.inventory.find((e) => e.disposition === "new");
    assert.equal(added?.rule, "no-debugger");
  });

  it("justification edits never change the fingerprint", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", `// eslint-disable-next-line no-console -- old reason\nconsole.log(1);\n`);
    r.commit("base");
    r.branch("base");
    r.write("app.js", `// eslint-disable-next-line no-console -- new reason\nconsole.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    const d = res.record!.summary.dispositions;
    assert.equal(d.existing, 1);
    assert.equal(d.new, 0);
  });
});
