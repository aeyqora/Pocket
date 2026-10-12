import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { cleanupTemps, fakeIo, tempDir, write } from "./harness.js";

after(cleanupTemps);

/**
 * Both severities actionable (spec §6.1): a warn and an error rule, each scoped
 * to the target's JS files so the action config itself is never linted.
 */
const CONFIG = `export default [
  { files: ["**/*.js"], rules: { "no-console": "warn", "no-unused-vars": "error" } },
];
`;

interface Fixture {
  dir: string;
  target: string;
}

/** A target directory of source files plus an action config one level above it. */
function fixture(files: Record<string, string>): Fixture {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) {
    write(dir, `target/${name}`, content);
  }
  write(dir, "comb.config.mjs", CONFIG);
  return { dir, target: join(dir, "target") };
}

/** Run `pocket-comb suppress` through the CLI IO seam on a fixture repo. */
async function suppress(
  dir: string,
  extra: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo({ cwd: dir });
  const code = await main(
    ["suppress", "-c", "comb.config.mjs", "-t", "target", "--workers", "1", ...extra],
    io.io,
  );
  return { code, out: io.stdout(), err: io.stderr() };
}

test("a dry run prints the exact impact summary and exits 1", async () => {
  const fix = fixture({
    "a.js": 'console.log("a");\nvar unused = 1;\n',
    "b.js": 'console.log("b");\n',
  });

  const { code, out } = await suppress(fix.dir);
  assert.equal(code, 1, "dry-run impact is the CI probe");

  const [headline, byType, byRule, done] = out.split("\n");
  assert.equal(headline, "Impact: 2 files would change, 3 edits (3 inserted, 0 prepended)");
  assert.equal(byType, "  by type: insert 3");
  assert.equal(byRule, "  by rule: no-console 2, no-unused-vars 1");
  assert.match(done!, /^Done: 2 files touched, 3 edits \(3 inserted, 0 prepended\) — \d+\.\ds$/);

  // A dry run never writes.
  assert.equal(readFileSync(join(fix.target, "a.js"), "utf8"), 'console.log("a");\nvar unused = 1;\n');
});

test("a zero-impact dry run exits 0", async () => {
  const fix = fixture({ "clean.js": "export default 1;\n" });

  const { code, out } = await suppress(fix.dir);
  assert.equal(code, 0);
  assert.ok(
    out.startsWith(
      "Impact: 0 files would change, 0 edits (0 inserted, 0 prepended)\n" +
        "  by type: none\n" +
        "  by rule: none\n",
    ),
  );
  assert.match(out, /Done: 0 files touched, 0 edits \(0 inserted, 0 prepended\)/);
});

test("--apply writes exactly the planned edits; a re-run reports zero impact", async () => {
  const fix = fixture({
    "a.js": 'console.log("a");\nvar unused = 1;\n',
    "b.js": 'console.log("b");\n',
  });

  const applied = await suppress(fix.dir, ["--apply"]);
  assert.equal(applied.code, 0, "an apply run succeeds");
  assert.ok(applied.out.startsWith("Impact: 2 files changed, 3 edits (3 inserted, 0 prepended)\n"));

  assert.equal(
    readFileSync(join(fix.target, "a.js"), "utf8"),
    "// eslint-disable-next-line no-console\n" +
      'console.log("a");\n' +
      "// eslint-disable-next-line no-unused-vars\n" +
      "var unused = 1;\n",
  );
  assert.equal(
    readFileSync(join(fix.target, "b.js"), "utf8"),
    '// eslint-disable-next-line no-console\nconsole.log("b");\n',
  );

  const rerun = await suppress(fix.dir);
  assert.equal(rerun.code, 0, "nothing left to suppress");
  assert.ok(
    rerun.out.startsWith("Impact: 0 files would change, 0 edits"),
    "idempotency: the applied directives suppress every violation",
  );
});

test("--reason appends to inserted directives only; prepends keep the existing description", async () => {
  const fix = fixture({
    "insert.js": 'console.log("y");\n',
    "prepend.js":
      '// eslint-disable-next-line no-console -- keep me\nvar unused = console.log("x");\n',
  });

  const { code } = await suppress(fix.dir, ["--apply", "--reason", "ticket-9"]);
  assert.equal(code, 0);

  assert.equal(
    readFileSync(join(fix.target, "insert.js"), "utf8"),
    '// eslint-disable-next-line no-console -- ticket-9\nconsole.log("y");\n',
    "the reason is appended to an inserted directive",
  );

  const prepended = readFileSync(join(fix.target, "prepend.js"), "utf8");
  assert.equal(
    prepended,
    '// eslint-disable-next-line no-unused-vars, no-console -- keep me\nvar unused = console.log("x");\n',
    "the existing description is preserved",
  );
  assert.doesNotMatch(prepended, /ticket-9/, "prepends never take the reason");
});

test("violations inside block spans and under file-level directives get minimal-span inserts", async () => {
  const fix = fixture({
    "block.js":
      '/* eslint-disable no-unused-vars */\nconsole.log("x");\n/* eslint-enable no-unused-vars */\n',
    "file-level.js": '/* eslint-disable no-unused-vars */\nconsole.log("y");\n',
  });

  const { code } = await suppress(fix.dir, ["--apply"]);
  assert.equal(code, 0);

  assert.equal(
    readFileSync(join(fix.target, "block.js"), "utf8"),
    "/* eslint-disable no-unused-vars */\n" +
      "// eslint-disable-next-line no-console\n" +
      'console.log("x");\n' +
      "/* eslint-enable no-unused-vars */\n",
    "a precise next-line insert inside the block span",
  );
  assert.equal(
    readFileSync(join(fix.target, "file-level.js"), "utf8"),
    "/* eslint-disable no-unused-vars */\n" +
      "// eslint-disable-next-line no-console\n" +
      'console.log("y");\n',
    "a precise next-line insert under the file-level directive",
  );
});

test("--reuse-blocks prepends onto the enclosing guard end-to-end", async () => {
  const fix = fixture({
    "block.js":
      '/* eslint-disable no-unused-vars -- legacy */\nconsole.log("x");\n/* eslint-enable no-unused-vars */\n',
  });

  const { code } = await suppress(fix.dir, ["--apply", "--reuse-blocks"]);
  assert.equal(code, 0);

  assert.equal(
    readFileSync(join(fix.target, "block.js"), "utf8"),
    "/* eslint-disable no-console, no-unused-vars -- legacy */\n" +
      'console.log("x");\n' +
      "/* eslint-enable no-unused-vars */\n",
    "the rule is prepended onto the block-open and the description survives",
  );
});

test("both warn- and error-severity violations are suppressed", async () => {
  const fix = fixture({ "both.js": 'console.log("a");\nvar unused = 1;\n' });

  const dry = await suppress(fix.dir);
  assert.equal(dry.code, 1);
  assert.match(dry.out, /by rule: no-console 1, no-unused-vars 1/);

  const applied = await suppress(fix.dir, ["--apply"]);
  assert.equal(applied.code, 0);
  const text = readFileSync(join(fix.target, "both.js"), "utf8");
  assert.match(text, /\/\/ eslint-disable-next-line no-console/, "the warn rule is suppressed");
  assert.match(
    text,
    /\/\/ eslint-disable-next-line no-unused-vars/,
    "the error rule is suppressed",
  );
});

test("the completion confirmation prints files touched, edit counts and elapsed", async () => {
  const fix = fixture({ "a.js": 'console.log("a");\n' });

  const { out } = await suppress(fix.dir);
  assert.match(out, /Done: 1 files touched, 1 edits \(1 inserted, 0 prepended\) — \d+\.\ds\n$/);
});

test("verbs without a command exit 2 with a 'not implemented yet' operational message", async () => {
  const fix = fixture({ "a.js": "export default 1;\n" });

  const invocations: string[][] = [
    ["cleanup"],
    ["inventory"],
  ];

  for (const invocation of invocations) {
    const io = fakeIo({ cwd: fix.dir });
    const code = await main([...invocation, "-c", "comb.config.mjs", "-t", "target"], io.io);
    assert.equal(code, 2, `${invocation[0]} exits 2`);
    assert.match(io.stderr(), /not implemented yet/, `${invocation[0]} names the gap`);
  }
});

test("a target with no matching files is an operational error (exit 2)", async () => {
  const dir = tempDir();
  write(dir, "comb.config.mjs", CONFIG);
  write(dir, "target/readme.md", "nothing to lint here\n");

  const io = fakeIo({ cwd: dir });
  const code = await main(["suppress", "-c", "comb.config.mjs", "-t", "target"], io.io);
  assert.equal(code, 2);
  assert.match(io.stderr(), /no files matched/);
});
