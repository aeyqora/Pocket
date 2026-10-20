import { test, after } from "node:test";
import assert from "node:assert/strict";
import { basename, join, resolve } from "node:path";
import { discover, DEFAULT_EXTENSIONS } from "../src/discovery.js";
import { cleanupTemps, tempDir, write } from "./harness.js";

after(cleanupTemps);

/** A fixture tree exercising every skip class plus a `.gitignore`. */
function fixtureRepo(): string {
  const dir = tempDir();
  write(dir, "a.js", "export default 1;\n");
  write(dir, "b.ts", "export default 1;\n");
  write(dir, "notes.md", "# not code\n");
  write(dir, ".dotfile.js", "export default 1;\n");
  write(dir, "ignored.js", "export default 1;\n");
  write(dir, "private/secret.js", "export default 1;\n");
  write(dir, "private/keep.js", "export default 1;\n");
  write(dir, "sub/kept.js", "export default 1;\n");
  write(dir, "sub/nested.ts", "export default 1;\n");
  write(dir, "node_modules/dep/index.js", "export default 1;\n");
  write(dir, "dist/bundle.js", "export default 1;\n");
  write(dir, ".cache/tmp.js", "export default 1;\n");
  write(dir, ".git/hooks/x.js", "export default 1;\n");
  write(dir, ".gitignore", "ignored.js\nprivate/\n!private/keep.js\n");
  return dir;
}

test("discover walks a directory honoring skips, extensions, and .gitignore", async () => {
  const dir = fixtureRepo();

  const result = await discover({ target: dir, extensions: [...DEFAULT_EXTENSIONS] });

  const names = result.files.map((file) => basename(file)).sort();
  assert.deepEqual(names, [".dotfile.js", "a.js", "b.ts", "keep.js", "kept.js", "nested.ts"]);

  // Absolute, sorted ascending, and de-duplicated.
  assert.ok(result.files.every((file) => resolve(file) === file), "every path is absolute");
  assert.deepEqual(result.files, [...result.files].sort());
  assert.equal(result.count, result.files.length);

  // Every returned path sits under the target.
  assert.ok(result.files.every((file) => file.startsWith(dir + "/")));
});

test("the extension list filters candidates", async () => {
  const dir = fixtureRepo();

  const onlyTs = await discover({ target: dir, extensions: [".ts"] });
  assert.deepEqual(
    onlyTs.files.map((file) => basename(file)).sort(),
    ["b.ts", "nested.ts"],
  );

  // Bare names (no leading dot) normalize the same way.
  const bare = await discover({ target: dir, extensions: ["js"] });
  assert.ok(bare.files.every((file) => file.endsWith(".js")));
  assert.ok(bare.files.length > 0);
});

test("a glob target is walked as a glob and still dedupes by extension", async () => {
  const dir = fixtureRepo();

  const result = await discover({ target: join(dir, "sub", "*.js"), extensions: [...DEFAULT_EXTENSIONS] });
  assert.deepEqual(result.files.map((file) => basename(file)), ["kept.js"]);
  assert.equal(result.count, 1);
});

test("a target that matches nothing yields an empty result, never a throw", async () => {
  const dir = tempDir();
  const result = await discover({ target: join(dir, "nope"), extensions: [...DEFAULT_EXTENSIONS] });
  assert.deepEqual(result, { files: [], count: 0 });
});

test("hardcoded skips apply at any depth", async () => {
  const dir = tempDir();
  write(dir, "keep.js", "export default 1;\n");
  write(dir, "deep/node_modules/x.js", "export default 1;\n");
  write(dir, "deep/dist/y.js", "export default 1;\n");
  write(dir, "deep/.git/z.js", "export default 1;\n");
  write(dir, "deep/.hidden/w.js", "export default 1;\n");

  const result = await discover({ target: dir, extensions: [...DEFAULT_EXTENSIONS] });
  assert.deepEqual(result.files.map((file) => basename(file)), ["keep.js"]);
});
