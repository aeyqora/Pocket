import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  type: string;
  license: string;
  engines: { node: string };
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  dependencies?: Record<string, string>;
};

test("package.json follows sibling conventions", () => {
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "Apache-2.0");
  assert.match(pkg.engines.node, />=20\.12/);
  assert.equal(pkg.peerDependencies.eslint, ">=9.34");
  assert.match(pkg.devDependencies.eslint!, /^\^?10/);
  assert.equal(pkg.scripts.test, 'node --import tsx --test "test/*.test.ts"');
  assert.equal(pkg.scripts.build, "tsc -p tsconfig.json");
  assert.equal(pkg.scripts.typecheck, "tsc -p tsconfig.json --noEmit");
});

test("the package ships no runtime dependencies (tests use synthetic fixtures only)", () => {
  assert.equal(pkg.dependencies, undefined);
});
