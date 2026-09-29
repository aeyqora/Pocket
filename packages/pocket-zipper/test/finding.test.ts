import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STATUS_CODES,
  defectsOf,
  documentDefect,
  finding,
  isDefect,
  renderFinding,
  type Finding,
} from "../src/finding.js";

/**
 * The two-tier policy, exercised through the interface the rest of the tool
 * crosses. A defect fails closed wherever a registry is read; a hygiene finding
 * is reported and never fails on its own.
 */
describe("finding: the two tiers", () => {
  it("takes a finding's severity from its code, never from the caller", () => {
    const defect = finding({ code: "MALFORMED", path: "p.yml", message: "bad" });
    const hygiene = finding({ code: "POOL_COUNTS", path: "p.yml", message: "untidy" });
    assert.equal(defect.severity, "defect");
    assert.equal(hygiene.severity, "hygiene");
    assert.ok(isDefect(defect));
    assert.ok(!isDefect(hygiene));
  });

  it("partitions findings so only the defects fail closed", () => {
    const findings: Finding[] = [
      finding({ code: "POOL_COUNTS", path: "p.yml", message: "hygiene" }),
      finding({ code: "INVALID_ENUM", path: "p.yml", message: "defect" }),
      finding({ code: "DANGLING_EXCEPTION", path: "p.yml", message: "hygiene" }),
    ];
    const defects = defectsOf(findings);
    assert.equal(defects.length, 1);
    assert.equal(defects[0]!.message, "defect");
    // The partition is the whole policy: a caller that reports everything takes
    // the input as it came, and a caller that must fail takes exactly this.
    assert.equal(findings.length, 3);
  });

  it("leaves a defect unqualified, because a whole document has no position", () => {
    const f = documentDefect(".pocket-zipper/config.yml", "not a mapping");
    assert.equal(f.code, "MALFORMED");
    assert.equal(f.severity, "defect");
    assert.equal(f.entry, null);
    assert.equal(f.field, null);
    assert.equal(f.line, null);
    assert.match(renderFinding(f), /^\.pocket-zipper\/config\.yml\s+MALFORMED\s+document\s/);
  });
});

describe("finding: one diagnostic line per finding", () => {
  it("addresses an entry and a field, with a line and column", () => {
    const f = finding({
      code: "MISSING_FIELD",
      path: ".pocket-zipper/exceptions.yml",
      entry: 2,
      field: "reason",
      position: { line: 7, column: 3 },
      message: "reason is required",
    });
    assert.equal(
      renderFinding(f),
      ".pocket-zipper/exceptions.yml:7:3  MISSING_FIELD  entry 2 · reason  reason is required",
    );
  });

  it("appends what the format wants, and what the file said instead", () => {
    const f = finding({
      code: "INVALID_ENUM",
      path: "p.yml",
      entry: 1,
      message: "type is not one of temporary|permanent",
      expected: "temporary or permanent",
      actual: "forever",
    });
    assert.match(
      renderFinding(f),
      /— expected temporary or permanent, got forever$/,
    );
  });

  it("falls back to column 1, so a line never renders as a bare colon", () => {
    const f = finding({
      code: "UNKNOWN_FIELD",
      path: "p.yml",
      position: { line: 4, column: null },
      message: "unknown field",
    });
    assert.match(renderFinding(f), /^p\.yml:4:1\s+UNKNOWN_FIELD\s/);
  });
});

describe("finding: the code vocabulary is closed", () => {
  it("names every utilization status except `used`", () => {
    // `used` is absent on purpose: a record in use is the registry working.
    assert.deepEqual(Object.keys(STATUS_CODES).sort(), ["dangling", "expired", "spent"]);
    assert.equal(STATUS_CODES.dangling, "DANGLING_EXCEPTION");
    assert.equal(STATUS_CODES.spent, "SPENT_EXCEPTION");
    assert.equal(STATUS_CODES.expired, "EXPIRED_EXCEPTION");
  });
});
