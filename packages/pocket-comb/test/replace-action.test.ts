import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { REPLACE_CLEANUP_HINT } from "../src/actions/replace.js";
import { WIZARD_CANCEL, type Prompter } from "../src/wizard.js";
import { cleanupTemps, fakeIo, tempDir, write } from "./harness.js";

after(cleanupTemps);

const CONFIG = `export default [
  {
    files: ["**/*.js"],
    rules: { "no-console": "warn", "no-unused-vars": "error" },
    settings: { "pocket-comb": { replace: { from: "settings-from", to: "settings-to" } } },
  },
];
`;

const SOURCE = [
  "/* eslint-disable no-console, no-unused-vars */",
  "const a = 1; // eslint-disable-line no-console, no-alert",
  "// eslint-disable-next-line no-console",
  "console.log(a);",
  "/* eslint-enable no-console, no-unused-vars */",
  "",
].join("\n");

interface Fixture {
  dir: string;
  target: string;
}

function fixture(files: Record<string, string>): Fixture {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) write(dir, `target/${name}`, content);
  write(dir, "comb.config.mjs", CONFIG);
  return { dir, target: join(dir, "target") };
}

async function replace(
  dir: string,
  extra: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const io = fakeIo({ cwd: dir });
  const code = await main(
    ["replace", "-c", "comb.config.mjs", "-t", "target", "--workers", "1", ...extra],
    io.io,
  );
  return { code, out: io.stdout(), err: io.stderr() };
}

test("a dry run prints the exact impact and exits 1 without writing", async () => {
  const fix = fixture({ "a.js": SOURCE });

  const { code, out } = await replace(fix.dir, ["--from", "no-console", "--to", "no-console-2"]);
  assert.equal(code, 1, "dry-run impact is the CI probe");

  const [headline, byType, byRule] = out.split("\n");
  assert.equal(headline, "Impact: 1 files would change, 4 edits (0 inserted, 0 prepended)");
  assert.equal(byType, "  by type: rename 4");
  assert.equal(byRule, "  by rule: no-console-2 4");
  assert.match(out, /^Done: 1 files touched, 4 edits/m);

  assert.equal(readFileSync(join(fix.target, "a.js"), "utf8"), SOURCE, "a dry run never writes");
});

test("--apply rewrites the tokens and is idempotent on re-run", async () => {
  const fix = fixture({ "a.js": SOURCE });

  const applied = await replace(fix.dir, ["--from", "no-console", "--to", "no-console-2", "--apply"]);
  assert.equal(applied.code, 0);
  assert.equal(
    readFileSync(join(fix.target, "a.js"), "utf8"),
    SOURCE.replaceAll("no-console,", "no-console-2,").replaceAll("no-console\n", "no-console-2\n"),
    "the tokens are renamed in place, the rest of every line is kept",
  );

  const rerun = await replace(fix.dir, ["--from", "no-console", "--to", "no-console-2"]);
  assert.equal(rerun.code, 0, "nothing left to rename");
  assert.ok(rerun.out.startsWith("Impact: 0 files would change, 0 edits"));
});

test("the settings pair is used when no flags carry one; --from/--to flags win over settings", async () => {
  const fix = fixture({ "a.js": "// eslint-disable-next-line settings-from\ncode();\n" });

  const fromSettings = await replace(fix.dir);
  assert.equal(fromSettings.code, 1);
  assert.match(fromSettings.out, /by rule: settings-to 1/, "the settings pair is the fallback");

  const fromFlags = await replace(fix.dir, ["--from", "settings-from", "--to", "flag-to"]);
  assert.match(fromFlags.out, /by rule: flag-to 1/, "the flags override settings.replace");
});

test("a missing pair in non-TTY exits 2 listing exactly --from and --to", async () => {
  const dir = tempDir();
  write(dir, "comb.config.mjs", `export default [{ files: ["**/*.js"], rules: {} }];\n`);
  write(dir, "target/a.js", "// eslint-disable-next-line no-console\ncode();\n");

  const io = fakeIo({ cwd: dir });
  const code = await main(["replace", "-c", "comb.config.mjs", "-t", "target"], io.io);
  assert.equal(code, 2);
  assert.match(io.stderr(), /missing required flags: --from, --to/);
});

test("a TTY replace without a pair defers to the wizard, never a missing-flags error", async () => {
  const dir = tempDir();
  write(dir, "comb.config.mjs", `export default [{ files: ["**/*.js"], rules: {} }];\n`);
  write(dir, "target/a.js", "// eslint-disable-next-line no-console\ncode();\n");

  const io = fakeIo({ cwd: dir, tty: true });
  const prompter: Prompter = {
    intro() {},
    outro() {},
    cancel() {},
    select: async () => WIZARD_CANCEL,
    text: async () => WIZARD_CANCEL,
    confirm: async () => WIZARD_CANCEL,
    path: async () => WIZARD_CANCEL,
  };
  const code = await main(["replace", "-c", "comb.config.mjs", "-t", "target"], io.io, { prompter });
  assert.equal(code, 0, "the wizard owns the pair gap; a cancel exits cleanly");
  assert.doesNotMatch(io.stderr(), /missing required/);
});

test("the report carries the cleanup hint when a rename happened, and the human line says so", async () => {
  const fix = fixture({ "a.js": SOURCE });

  const { code, out, err } = await replace(fix.dir, [
    "--from",
    "no-console",
    "--to",
    "no-console-2",
    "--format",
    "json",
    "--out",
    "-",
  ]);
  assert.equal(code, 1);

  const report = JSON.parse(out) as { hint?: string; edits: Array<{ editType: string }> };
  assert.equal(report.hint, REPLACE_CLEANUP_HINT);
  assert.ok(report.edits.every((edit) => edit.editType === "rename"));
  assert.match(err, /Next: run cleanup to prune now-unused directives/, "human output carries it too");
});

test("no cleanup hint when the pair matched nothing", async () => {
  const fix = fixture({ "a.js": "// eslint-disable-next-line no-alert\ncode();\n" });

  const { code, out } = await replace(fix.dir, [
    "--from",
    "no-console",
    "--to",
    "no-console-2",
    "--format",
    "json",
    "--out",
    "-",
  ]);
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).hint, undefined);
  assert.doesNotMatch(out, /cleanup/);
});

test("the HTML report renders the hint as the next step", async () => {
  const fix = fixture({ "a.js": SOURCE });

  await replace(fix.dir, ["--from", "no-console", "--to", "no-console-2", "--format", "html", "--out", "r.html"]);
  const html = readFileSync(join(fix.dir, "r.html"), "utf8");
  assert.match(html, /Next step/);
  assert.match(html, /run cleanup to prune now-unused directives/);
});
