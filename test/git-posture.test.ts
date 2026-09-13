import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRepo,
  eslintConfig,
  runCliIn,
  type FixtureRepo,
} from "./harness.js";
import { parseNumstat } from "../src/git.js";

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

function repo(): FixtureRepo {
  const r = createRepo();
  repos.push(r);
  return r;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

const disabled = "// eslint-disable-next-line no-console\n";

describe("change map", () => {
  it("records renamed binary paths as binary (numstat parser)", () => {
    const binary = new Set<string>();
    parseNumstat("-\t-\t\u0000old.bin\u0000lib/new.bin\u0000", binary);
    assert.ok(binary.has("lib/new.bin"));
  });

  it("skips binary changed files", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.writeBytes("data.bin", Buffer.from([0x00, 0x01, 0x02, 0x03]));
    r.commit("base");
    r.branch("base");
    r.writeBytes("data.bin", Buffer.from([0x00, 0xff, 0xfe, 0x03]));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.verdict, "pass");
    assert.deepEqual(res.record?.inventory, []);
  });

  it("resolves a git-recognized rename without treating it as add + delete", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("old.js", `${disabled}console.log(1);\n`);
    r.commit("base");
    r.branch("base");
    r.mkdir("lib");
    r.git(["mv", "old.js", "lib/new.js"]);
    r.commit("rename");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.removed, 0);
    assert.equal(res.record?.summary.dispositions.new, 0);
  });
});

describe("detached HEAD", () => {
  it("resolves base and head as explicit commits", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    r.git(["checkout", "-q", "--detach", "HEAD"]);
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.match(res.record?.baseline.tree ?? "", /^[0-9a-f]{40}$/);
    assert.match(res.record?.proposedChange.tree ?? "", /^[0-9a-f]{40}$/);
  });
});

describe("bare repository", () => {
  it("evaluates check mode using object-graph forms only", () => {
    const src = repo();
    src.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    src.write("app.js", "export const a = 1;\n");
    src.commit("base");
    src.branch("base");
    src.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    src.commit("head");

    const bareDir = mkdtempSync(join(tmpdir(), "pocket-lock-bare-"));
    rmSync(bareDir, { recursive: true, force: true });
    git(src.dir, ["clone", "-q", "--bare", src.dir, bareDir]);
    const res = runCliIn(bareDir, ["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.dispositions.new, 1);
    assert.deepEqual(res.record?.errors, []);
    rmSync(bareDir, { recursive: true, force: true });
  });
});

describe("git failure posture", () => {
  it("fails closed with a record when the base ref is missing", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    const res = r.runCli(["check", "--base", "does-not-exist"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "GIT_ERROR");
    assert.match(res.record?.errors[0]?.message ?? "", /cannot resolve ref/i);
  });

  it("fails closed with GIT_ERROR when run outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-lock-norepo-"));
    const res = runCliIn(dir, ["check", "--base", "main"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "GIT_ERROR");
    assert.match(res.record?.errors[0]?.message ?? "", /not a git repository/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed when a shallow clone cannot be unshallowed", () => {
    const src = repo();
    src.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    src.write("app.js", "export const a = 1;\n");
    src.commit("base");
    src.write("app.js", "export const a = 2;\n");
    src.commit("head");

    const shallowDir = mkdtempSync(join(tmpdir(), "pocket-lock-shallow-"));
    rmSync(shallowDir, { recursive: true, force: true });
    git(src.dir, ["clone", "-q", "--depth", "1", `file://${src.dir}`, shallowDir]);
    git(shallowDir, ["remote", "set-url", "origin", "file:///nonexistent/repo.git"]);
    const res = runCliIn(shallowDir, ["check", "--base", "HEAD"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "GIT_ERROR");
    assert.match(res.record?.errors[0]?.message ?? "", /shallow/i);
    assert.match(res.record?.errors[0]?.message ?? "", /full clone|pinned base/i);
    rmSync(shallowDir, { recursive: true, force: true });
  });

  it("attempts to unshallow a shallow clone before failing", () => {
    const src = repo();
    src.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    src.write("app.js", "export const a = 1;\n");
    const baseSha = src.commit("base");
    src.branch("base");
    src.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    src.commit("head");

    const shallowDir = mkdtempSync(join(tmpdir(), "pocket-lock-deepen-"));
    rmSync(shallowDir, { recursive: true, force: true });
    git(src.dir, ["clone", "-q", "--depth", "1", `file://${src.dir}`, shallowDir]);
    const res = runCliIn(shallowDir, ["check", "--base", baseSha]);
    assert.notEqual(res.status, 2);
    assert.equal(res.record?.summary.dispositions.new, 1);
    rmSync(shallowDir, { recursive: true, force: true });
  });

  it("fails closed when a promisor/partial clone is detected", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    r.git(["config", "remote.origin.url", "https://example.invalid/repo"]);
    r.git(["config", "remote.origin.promisor", "true"]);
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "GIT_ERROR");
    assert.match(res.record?.errors[0]?.message ?? "", /full clone/i);
  });
});
