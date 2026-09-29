import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupRepos,
  eslintConfig,
  exceptionYaml,
  NEXT_LINE_NO_CONSOLE_FP,
  PROTECTED_REGISTRY,
  repo,
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";
import { addDuration } from "../src/policy.js";

after(cleanupRepos);

const IN_WINDOW = () => addDuration(new Date().toISOString().slice(0, 10), "30d");

/**
 * A repo whose baseline registry holds one record that authorizes nothing, plus a
 * committed baseline. `check` resolves it to dangling: the record's suppression
 * is not in the tree it is compared against.
 */
function danglingRepo(): FixtureRepo {
  const r = repo();
  r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
  r.write(PROTECTED_REGISTRY, exceptionYaml({
    rule: "no-console",
    suppressionType: "next-line",
    fingerprint: NEXT_LINE_NO_CONSOLE_FP,
    file: "app.js",
    type: "permanent",
  }));
  r.write("app.js", "export const a = 1;\n");
  r.commit("base");
  r.branch("base");
  r.write("app.js", "export const a = 2;\n");
  r.commit("head");
  return r;
}

describe("the published record, as a machine reads it", () => {
  it("carries the delete-ready pointer for every unused record", () => {
    // The whole point of schema v2. A v1 consumer could read the count in
    // `summary.cleanup.danglingExceptions` and had no way to learn which record it
    // referred to; the core never deletes a record, so the pointer is the only
    // route from "this record authorizes nothing" to "cut these lines".
    const r = danglingRepo();
    const res = r.runCli(["check", "--base", "base"]);
    const record = res.record!;

    assert.equal(record.schemaVersion, 2);
    assert.equal(record.summary.cleanup.danglingExceptions, 1);
    assert.equal(record.unused.length, 1);

    const pointer = record.unused[0]!;
    assert.equal(pointer.status, "dangling");
    assert.equal(pointer.entry, 1);
    assert.equal(pointer.entries, 1);
    // The range and the text are what make deletion find-in-one-glance: a
    // pointer that does not land on the record is a broken pointer.
    assert.deepEqual(pointer.registryLines, { start: 1, end: 7 });
    assert.match(pointer.text, /^- rule: no-console/);
    assert.equal(pointer.live, null, "a dangling record has no live location");
    assert.equal(pointer.clearedByThisChange, false);
  });

  it("points at a record the registry actually carries", () => {
    const r = danglingRepo();
    const res = r.runCli(["check", "--base", "base"]);
    const pointer = res.record!.unused[0]!;
    const lines = r.read(PROTECTED_REGISTRY).split("\n");
    // The named range holds the record's own text, verbatim.
    const span = lines.slice(pointer.registryLines!.start - 1, pointer.registryLines!.end);
    assert.equal(span.join("\n"), pointer.text);
  });

  it("publishes an empty list when nothing is unused, never omits the field", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const record = r.runCli(["check", "--base", "base"]).record!;
    assert.deepEqual(record.unused, []);
    assert.ok("unused" in record, "the field is present, not absent");
  });

  it("tells a consumer whether the change itself cleared the record", () => {
    // The one cleanup signal addressed to the author of this change rather than
    // to a maintainer sweeping later.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, exceptionYaml({
      rule: "no-console",
      suppressionType: "next-line",
      fingerprint: NEXT_LINE_NO_CONSOLE_FP,
      file: "app.js",
      type: "permanent",
    }));
    r.write("app.js", `export const a = 1;\n// eslint-disable-next-line no-console\nconsole.log(1);\n`);
    r.commit("base");
    r.branch("base");
    // The change removes the suppression the record excepted.
    r.write("app.js", "export const a = 1;\n");
    r.commit("drop the suppression");
    const record = r.runCli(["check", "--base", "base"]).record!;
    assert.equal(record.unused.length, 1);
    assert.equal(record.unused[0]!.clearedByThisChange, true);
  });
});
