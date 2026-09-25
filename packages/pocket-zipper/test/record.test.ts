import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRecord,
  excludedRecord,
  failureRecord,
  summarize,
  TOOL_VERSION,
} from "../src/record.js";
import type {
  ExceptionRecord,
  LogicalSuppression,
  ReconciledSuppression,
} from "../src/types.js";

const FP = "v1:fp:no-console";

function head(overrides: Partial<ReconciledSuppression> = {}): ReconciledSuppression {
  return {
    fingerprint: FP,
    rule: "no-console",
    suppressionType: "next-line",
    guardKind: "directive",
    file: "app.js",
    line: 5,
    guardStart: 6,
    guardEnd: 6,
    guardedContent: "",
    justification: "",
    canonicalText: "",
    namedRules: ["no-console"],
    disposition: "existing",
    baselineLine: null,
    exception: null,
    ...overrides,
  };
}

function removed(overrides: Partial<LogicalSuppression> = {}): LogicalSuppression {
  return {
    fingerprint: FP,
    rule: "no-console",
    suppressionType: "next-line",
    guardKind: "directive",
    file: "app.js",
    line: 5,
    guardStart: 6,
    guardEnd: 6,
    guardedContent: "",
    justification: "",
    canonicalText: "",
    namedRules: ["no-console"],
    ...overrides,
  };
}

const ref = { fingerprint: FP, suppressionType: "next-line" as const, rule: "no-console" };

describe("record: summarize", () => {
  it("counts every disposition and takes removed from the caller", () => {
    const summary = summarize(
      [
        head({ disposition: "existing" }),
        head({ disposition: "moved-existing" }),
        head({ disposition: "new" }),
        head({ disposition: "materially-changed" }),
      ],
      3,
    );
    assert.deepEqual(summary.dispositions, {
      existing: 1,
      movedExisting: 1,
      removed: 3,
      new: 1,
      materiallyChanged: 1,
    });
  });

  it("splits new debt into authorized and unauthorized", () => {
    const summary = summarize(
      [
        head({ disposition: "new", exception: null }),
        head({ disposition: "new", exception: ref }),
        head({ disposition: "materially-changed", exception: null }),
        head({ disposition: "existing", exception: ref }),
      ],
      0,
    );
    assert.deepEqual(summary.newDebt, { authorized: 1, unauthorized: 2 });
  });

  it("reports no new debt when nothing is new or materially-changed", () => {
    const summary = summarize([head({ disposition: "moved-existing" })], 4);
    assert.deepEqual(summary.newDebt, { authorized: 0, unauthorized: 0 });
  });
});

describe("record: buildRecord", () => {
  const record: ExceptionRecord = {
    rule: "no-console",
    suppression_type: "next-line",
    fingerprint: FP,
    file: "app.js",
    type: "permanent",
    reason: "r",
    reference: "ref",
  };

  function build(overrides: Partial<Parameters<typeof buildRecord>[0]> = {}) {
    return buildRecord({
      mode: "check",
      verdict: "fail",
      baseline: { ref: "main", tree: "b".repeat(40) },
      proposedTree: "a".repeat(40),
      policy: { enabled: true, governedRules: ["no-console"] },
      governedRules: ["no-console"],
      head: [head({ disposition: "new", exception: ref })],
      removed: [removed()],
      registry: [record],
      cleanup: { expired: 1, dangling: 2, spent: 3 },
      poolCounts: [],
      exceptionStatuses: new Map([[record, "used"]]),
      errors: [{ code: "POLICY_CHANGE", message: "weakened" }],
      ...overrides,
    });
  }

  it("stamps the schema, tool, refs, and summary", () => {
    const out = build();
    assert.equal(out.schemaVersion, 1);
    assert.equal(out.tool.version, TOOL_VERSION);
    assert.equal(out.mode, "check");
    assert.equal(out.verdict, "fail");
    assert.deepEqual(out.baseline, { ref: "main", tree: "b".repeat(40) });
    assert.deepEqual(out.proposedChange, { ref: "HEAD", tree: "a".repeat(40) });
    assert.deepEqual(out.summary.policy, { enabled: true, allowlist: ["no-console"] });
    assert.deepEqual(out.summary.governedRules, ["no-console"]);
    assert.equal(out.summary.dispositions.removed, 1);
    assert.equal(out.summary.newDebt.authorized, 1);
    assert.equal(out.summary.newDebt.unauthorized, 0);
    assert.deepEqual(out.summary.cleanup, {
      danglingExceptions: 2,
      spentExceptions: 3,
      expiredExceptions: 1,
      poolCounts: [],
    });
  });

  it("maps head and removed suppressions into the inventory", () => {
    const out = build();
    assert.equal(out.inventory.length, 2);
    const removedEntry = out.inventory.find((e) => e.disposition === "removed")!;
    assert.equal(removedEntry.lines.head, null);
    assert.equal(removedEntry.exception, null);
    const headEntry = out.inventory.find((e) => e.disposition === "new")!;
    assert.equal(headEntry.lines.head, 5);
    assert.equal(headEntry.exception?.fingerprint, FP);
  });

  it("maps registry records to exception entries with their status", () => {
    const out = build();
    assert.equal(out.exceptions[0]?.status, "used");
    assert.equal(out.exceptions[0]?.suppressionType, "next-line");
    assert.equal(out.errors[0]?.code, "POLICY_CHANGE");
  });

  it("uses the index ref in pre-commit mode and defaults an unmatched status", () => {
    const out = build({ mode: "pre-commit", exceptionStatuses: new Map() });
    assert.equal(out.proposedChange.ref, "index");
    assert.equal(out.exceptions[0]?.status, "dangling");
  });
});

describe("record: empty records", () => {
  it("builds the excluded record with the policy echoed", () => {
    const out = excludedRecord({
      mode: "check",
      baseline: { ref: "main", tree: "t".repeat(40) },
      proposedTree: "p".repeat(40),
      policy: { enabled: false, governedRules: null },
    });
    assert.equal(out.verdict, "excluded");
    assert.equal(out.inventory.length, 0);
    assert.equal(out.exceptions.length, 0);
    assert.deepEqual(out.summary.policy, { enabled: false, allowlist: null });
    assert.equal(out.proposedChange.ref, "HEAD");
  });

  it("builds the operational-failure record with empty trees", () => {
    const out = failureRecord({
      mode: "pre-commit",
      baseRef: "main",
      errors: [{ code: "GIT_ERROR", message: "no merge-base" }],
    });
    assert.equal(out.verdict, "fail");
    assert.deepEqual(out.baseline, { ref: "main", tree: "" });
    assert.deepEqual(out.proposedChange, { ref: "index", tree: "" });
    assert.equal(out.errors[0]?.code, "GIT_ERROR");
    assert.equal(out.summary.policy.enabled, true);
  });
});
