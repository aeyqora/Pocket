import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  eslintConfig,
  repo,
  cleanupRepos,
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";
import { EMPTY_TREE } from "../src/git.js";
import { TOOL_VERSION } from "../src/record.js";
import type { EvaluationRecord } from "../src/types.js";

after(cleanupRepos);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("package contract", () => {
  it("ships the pocket-zipper binary with only the YAML runtime dependency", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      bin: Record<string, string>;
      dependencies: Record<string, string>;
      files: string[];
    };
    assert.equal(pkg.bin["pocket-zipper"], "dist/cli.js");
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["yaml"]);
    assert.ok(pkg.files.includes("dist"));
  });

  it("pins the tool version to package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(TOOL_VERSION, pkg.version);
  });

  it("packs, unpacks and runs the packaged binary end to end", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pocket-zipper-pack-"));
    try {
      const packOut = execFileSync(
        "npm",
        ["pack", "--json", "--pack-destination", tmp],
        { cwd: ROOT, encoding: "utf8" },
      );
      const parsed = JSON.parse(packOut) as
        | Array<{ filename: string }>
        | Record<string, { filename: string }>;
      const packed = (Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0])!;
      const extractDir = join(tmp, "extract");
      mkdirSync(extractDir, { recursive: true });
      execFileSync("tar", ["-xzf", join(tmp, packed.filename), "-C", extractDir]);

      const pkgDir = join(extractDir, "package");
      const cli = join(pkgDir, "dist", "cli.js");
      assert.ok(existsSync(cli), "the packed artifact must contain the built CLI");
      // Make exactly the runtime dependency and the ESLint peer resolvable,
      // offline, so the artifact runs with only what the package declares.
      const modules = join(pkgDir, "node_modules");
      mkdirSync(modules, { recursive: true });
      for (const dep of ["yaml", "eslint"]) {
        const source = join(ROOT, "node_modules", dep);
        if (existsSync(source)) symlinkSync(source, join(modules, dep), "junction");
      }

      // Fresh repo -> empty-tree baseline -> staged first commit with a
      // governed suppression -> exit 1 under the default (enabled) policy.
      const fixture = repo();
      fixture.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
      fixture.write("app.js", "// eslint-disable-next-line no-console\nconsole.log(1);\n");
      fixture.stage();
      const recordPath = join(tmp, "record.json");
      const res = spawnSync(
        process.execPath,
        [cli, "pre-commit", "--json", recordPath],
        { cwd: fixture.dir, encoding: "utf8" },
      );
      assert.equal(res.status, 1, res.stderr);
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as EvaluationRecord;
      assert.equal(record.mode, "pre-commit");
      assert.equal(record.baseline.tree, EMPTY_TREE);
      assert.equal(record.summary.dispositions.new, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
