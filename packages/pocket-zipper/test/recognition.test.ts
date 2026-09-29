import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  eslintConfig,
  repo,
  cleanupRepos,
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";

after(cleanupRepos);

const noConsoleNextLine = "// eslint-disable-next-line no-console\n";

describe("inline-directive recognition", () => {
  it("counts an unused (near-miss) directive as a logical suppression", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${noConsoleNextLine}const b = 2;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    const entry = res.record?.inventory.find((e) => e.disposition === "new");
    assert.equal(entry?.rule, "no-console");
    assert.equal(entry?.suppressionType, "next-line");
  });

  it("expands an unnamed broad directive to one suppression per applicable rule", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "/* eslint-disable */\nconsole.log(1);\ndebugger;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.dispositions.new, 2);
    const rules = res.record?.inventory
      .filter((e) => e.disposition === "new")
      .map((e) => e.rule)
      .sort();
    assert.deepEqual(rules, ["no-console", "no-debugger"]);
    for (const entry of res.record?.inventory ?? []) {
      assert.equal(entry.suppressionType, "file-level directive");
    }
  });

  it("yields zero inline suppressions for a noInlineConfig file", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      `export default [\n  {\n    linterOptions: { noInlineConfig: true },\n    rules: { "no-console": "error" },\n  },\n];\n`,
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${noConsoleNextLine}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });

  it("ignores a multi-line eslint-disable-line directive", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "/* eslint-disable-line\n   no-console */\nconsole.log(1);\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });

  it("judges applicability per file, not across the whole tree", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      [
        "export default [",
        '  { files: ["a.js"], rules: { "no-console": "error" } },',
        '  { files: ["z.js"], rules: { "no-console": "off" } },',
        "];",
        "",
      ].join("\n"),
    );
    r.write("a.js", "export const a = 1;\n");
    r.write("z.js", "export const z = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("a.js", "export const a = 2;\n");
    r.write("z.js", "// eslint-disable-next-line no-console\nconst x = 1;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });

  it("keeps the un-re-enabled rules of a block suppressed to EOF", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      "app.js",
      "/* eslint-disable no-console, no-debugger */\nconsole.log(1);\n/* eslint-enable no-console */\ndebugger;\n",
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    const entries = res.record?.inventory ?? [];
    assert.deepEqual(
      entries.map((e) => e.rule).sort(),
      ["no-console", "no-debugger"],
    );
    assert.ok(entries.some((e) => e.suppressionType === "block"));
    assert.ok(entries.some((e) => e.suppressionType === "file-level directive"));
  });

  it("ignores a directive naming a rule ESLint cannot define", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "// eslint-disable-next-line totally-unknown-rule\nfoo();\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });

  it("ignores per-file parse errors without failing the gate", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", `${noConsoleNextLine}console.log(1);\n`);
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${noConsoleNextLine}console.log(1;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.new, 0);
    assert.equal(res.record?.summary.dispositions.removed, 1);
  });
});
