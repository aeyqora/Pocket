/**
 * Pack-and-smoke test (ticket 14): pack the built package, inspect the tarball,
 * install it into a scratch repo outside this package, and drive the *installed*
 * bin through a real `suppress` dry run and an `inventory` census.
 *
 * This is deliberately **not** part of `npm test`. It shells out to `npm pack`
 * and `npm install` (the latter fetches the `eslint` peer from the registry), it
 * runs the worker pool, and it asserts on a tarball's file list — slow and
 * environment-sensitive, so it lives behind `npm run test:pack`.
 *
 * The seam is the packed artifact and the installed bin, never the source tree:
 * if the tarball is missing `dist/cli.js`, ships a stray `test/` directory, or
 * the installed bin cannot run an action end to end, this fails.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[], cwd: string): Result {
  const res: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function step(label: string): void {
  process.stdout.write(`\n== ${label}\n`);
}

/** `npm pack --json` shape: npm <= 11 emits an array, npm >= 12 an object keyed by name. */
function packedEntry(raw: string): { filename: string; files: Array<{ path: string }> } {
  const parsed: unknown = JSON.parse(raw);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0];
  assert.ok(entry !== undefined, "npm pack --json produced no entry");
  return entry as { filename: string; files: Array<{ path: string }> };
}

function main(): void {
  if (!existsSync(CLI)) {
    throw new Error(`built bin missing at ${CLI}; run \`npm run build\` first`);
  }

  const work = mkdtempSync(join(tmpdir(), "pocket-comb-pack-smoke-"));
  try {
    // 1. Pack the built package into the scratch area.
    step("npm pack");
    const packed = run("npm", ["pack", "--json", "--pack-destination", work], ROOT);
    assert.equal(packed.status, 0, `npm pack failed:\n${packed.stderr}`);
    const { filename, files } = packedEntry(packed.stdout);
    const tarball = join(work, filename);
    assert.ok(existsSync(tarball), `tarball not written: ${tarball}`);
    const paths = files.map((file) => file.path).sort();
    process.stdout.write(`${paths.length} files in ${filename}\n`);

    // 2. The tarball ships bin + dist + docs and nothing else. Every path must be
    //    one of the allowed shapes; a stray `test/`, `perf/`, `src/`, `.scratch/`,
    //    or `node_modules/` entry fails here.
    step("tarball contents");
    for (const path of paths) {
      assert.match(
        path,
        /^(dist\/|docs\/|README\.md$|CHANGELOG\.md$|LICENSE$|package\.json$)/,
        `unexpected file in tarball: ${path}`,
      );
    }
    for (const required of [
      "package.json",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "docs/README.md",
      "docs/configuration.md",
      "docs/actions.md",
      "docs/examples.md",
      "docs/reference.md",
      "dist/cli.js",
      "dist/index.js",
      "dist/index.d.ts",
    ]) {
      assert.ok(paths.includes(required), `tarball is missing ${required}`);
    }

    // 3. The metadata the tarball actually ships (not the working tree's copy).
    step("packed metadata");
    const packedPkg = run("tar", ["-xOf", tarball, "package/package.json"], work);
    assert.equal(packedPkg.status, 0, `could not read packed package.json:\n${packedPkg.stderr}`);
    const meta = JSON.parse(packedPkg.stdout) as {
      engines?: { node?: string };
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      bin?: Record<string, string>;
      license?: string;
      files?: string[];
    };
    assert.equal(meta.engines?.node, ">=20.12.0");
    assert.equal(meta.peerDependencies?.eslint, ">=9.34");
    assert.notEqual(
      meta.peerDependenciesMeta?.eslint?.optional,
      true,
      "the eslint peer must not be optional",
    );
    assert.equal(meta.bin?.["pocket-comb"], "dist/cli.js");
    assert.equal(meta.license, "Apache-2.0");
    for (const entry of ["dist", "docs", "README.md", "CHANGELOG.md", "LICENSE"]) {
      assert.ok(meta.files?.includes(entry), `package.json files is missing ${entry}`);
    }
    process.stdout.write("engines, peer, bin, license, files: ok\n");

    // 4. A realistic scratch repo: its own ESLint config (which the tool must
    //    never read), an action config, suppressed + unsuppressed JS, and a TS
    //    file the action config does not cover (the files-coverage requirement).
    step("scratch repo");
    const repo = join(work, "repo");
    write(repo, "package.json", `{\n  "name": "pocket-comb-smoke-repo",\n  "private": true,\n  "type": "module"\n}\n`);
    write(
      repo,
      "eslint.config.js",
      // The repo's own config ignores the file the action config targets and
      // governs a rule the action config does not. If pocket-comb ever read it,
      // the suppress dry run would find nothing.
      `export default [\n  { ignores: ["src/violations.js"] },\n  { rules: { eqeqeq: "error" } },\n];\n`,
    );
    write(
      repo,
      "pocket-comb.config.mjs",
      `export default [\n  {\n    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],\n    rules: { "no-console": "warn" },\n    settings: { "pocket-comb": { target: "src" } },\n  },\n];\n`,
    );
    write(repo, "src/clean.js", `// eslint-disable-next-line no-console\nconsole.log("suppressed");\n`);
    write(repo, "src/violations.js", `console.log("one");\nconst x = 1;\nconsole.log(x);\n`);
    write(repo, "src/unconfigured.ts", `console.log("ts");\n`);

    // 5. Install the tarball. npm >= 7 auto-installs the non-optional `eslint`
    //    peer, so this also proves the peer metadata is installable.
    step("npm install <tarball>");
    const installed = run("npm", ["install", "--no-audit", "--no-fund", tarball], repo);
    assert.equal(installed.status, 0, `npm install failed:\n${installed.stderr}`);
    assert.ok(existsSync(join(repo, "node_modules", ".bin", "pocket-comb")));

    // 6. Drive the installed bin the way a user would: `npx` resolves the local
    //    install (`--no-install` forbids a registry fallback).
    const npx = (args: string[]): Result => run("npx", ["--no-install", "pocket-comb", ...args], repo);

    step("npx pocket-comb --version");
    const version = npx(["--version"]);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), "0.1.0");

    step("npx pocket-comb suppress --dry-run");
    const suppress = npx([
      "suppress",
      "--config",
      "pocket-comb.config.mjs",
      "--dry-run",
      "--no-report",
    ]);
    // Exit 1 is the CI probe: a dry run with impact.
    assert.equal(suppress.status, 1, suppress.stderr);
    assert.match(suppress.stdout, /Impact: 1 files would change, 2 edits \(2 inserted, 0 prepended\)/);
    assert.match(suppress.stdout, /Done: 1 files touched, 2 edits/);

    step("npx pocket-comb suppress --format json --out -");
    const suppressJson = npx([
      "suppress",
      "--config",
      "pocket-comb.config.mjs",
      "--dry-run",
      "--format",
      "json",
      "--out",
      "-",
    ]);
    assert.equal(suppressJson.status, 1, suppressJson.stderr);
    const report = JSON.parse(suppressJson.stdout) as {
      meta: { counts: Record<string, number> };
      edits: unknown[];
    };
    // discovered 3 (two JS + one TS), linted 2, dropped 1 — the uncovered TS file.
    assert.deepEqual(report.meta.counts, { discovered: 3, linted: 2, dropped: 1, touched: 1 });
    assert.equal(report.edits.length, 2);

    step("npx pocket-comb inventory --format json --out -");
    const inventory = npx([
      "inventory",
      "--config",
      "pocket-comb.config.mjs",
      "--format",
      "json",
      "--out",
      "-",
    ]);
    assert.equal(inventory.status, 0, inventory.stderr);
    const census = JSON.parse(inventory.stdout) as {
      meta: { counts: { discovered: number } };
      totals: Array<{ form: string; rule: string; count: number }>;
    };
    assert.equal(census.meta.counts.discovered, 3);
    assert.deepEqual(census.totals, [{ form: "next-line", rule: "no-console", count: 1 }]);

    process.stdout.write("\npack-smoke: ok\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function write(repo: string, relative: string, content: string): void {
  const full = join(repo, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

main();
