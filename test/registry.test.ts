import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coverExceptions, recordMatchKey } from "../src/registry.js";
import { PocketZipperError } from "../src/errors.js";
import type { ExceptionRecord, ReconciledSuppression } from "../src/types.js";

const NOW = new Date("2026-09-14T12:00:00Z");
const FP_NC = "v1:fp:no-console";

function suppression(overrides: Partial<ReconciledSuppression> = {}): ReconciledSuppression {
  return {
    fingerprint: FP_NC,
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
    disposition: "new",
    baselineLine: null,
    exception: null,
    ...overrides,
  };
}

function record(overrides: Partial<ExceptionRecord> = {}): ExceptionRecord {
  return {
    rule: "no-console",
    suppression_type: "next-line",
    fingerprint: FP_NC,
    file: "app.js",
    type: "permanent",
    reason: "needed",
    owner: "@team",
    reference: "#1",
    ...overrides,
  };
}

describe("registry: coverExceptions matching", () => {
  it("authorizes a matching new suppression without mutating the input", () => {
    const h = suppression();
    const r = record();
    const out = coverExceptions({ head: [h], records: [r], now: NOW });
    assert.equal(h.exception, null);
    assert.equal(out.head[0]!.exception?.fingerprint, FP_NC);
    assert.equal(out.statuses.get(r), "used");
    assert.equal(out.counts.used, 1);
  });

  it("does not authorize on a mismatched fingerprint, rule, or type", () => {
    for (const r of [
      record({ fingerprint: `v1:sha256:${"0".repeat(64)}` }),
      record({ rule: "no-debugger" }),
      record({ suppression_type: "line" }),
    ]) {
      const out = coverExceptions({ head: [suppression()], records: [r], now: NOW });
      assert.equal(out.head[0]!.exception, null);
      assert.equal(out.statuses.get(r), "dangling");
    }
  });

  it("keys records on fingerprint, type, and rule only", () => {
    assert.equal(
      recordMatchKey(record()),
      recordMatchKey(record({ file: "elsewhere.js", reason: "other" })),
    );
    assert.notEqual(recordMatchKey(record()), recordMatchKey(record({ rule: "no-debugger" })));
  });
});

describe("registry: lifecycle classification", () => {
  it("marks an expired record distinctly and does not authorize with it", () => {
    const r = record({ type: "temporary", expires: "2000-01-01" });
    const out = coverExceptions({ head: [suppression()], records: [r], now: NOW });
    assert.equal(out.head[0]!.exception, null);
    assert.equal(out.statuses.get(r), "expired");
    assert.equal(out.counts.expired, 1);
  });

  it("authorizes through the end of a future UTC date", () => {
    const r = record({ type: "temporary", expires: "2099-01-01" });
    const out = coverExceptions({ head: [suppression()], records: [r], now: NOW });
    assert.ok(out.head[0]!.exception);
    assert.equal(out.statuses.get(r), "used");
  });

  it("reports a record matching no suppression as dangling", () => {
    const r = record({ fingerprint: "v1:fp:absent" });
    const out = coverExceptions({ head: [suppression()], records: [r], now: NOW });
    assert.equal(out.statuses.get(r), "dangling");
    assert.equal(out.counts.dangling, 1);
  });

  it("reports a record whose suppression is already existing debt as spent", () => {
    const r = record();
    const out = coverExceptions({
      head: [suppression({ disposition: "existing" })],
      records: [r],
      now: NOW,
    });
    assert.equal(out.statuses.get(r), "spent");
    assert.equal(out.counts.spent, 1);
  });

  it("reports expired ahead of spent for an expired record on existing debt", () => {
    const r = record({ type: "temporary", expires: "2000-01-01" });
    const out = coverExceptions({
      head: [suppression({ disposition: "moved-existing" })],
      records: [r],
      now: NOW,
    });
    assert.equal(out.statuses.get(r), "expired");
  });

  it("lets the first matching record win and classifies the rest", () => {
    const first = record();
    const second = record();
    const out = coverExceptions({ head: [suppression()], records: [first, second], now: NOW });
    assert.equal(out.statuses.get(first), "used");
    assert.equal(out.statuses.get(second), "dangling");
    assert.equal(out.counts.used, 1);
    assert.equal(out.counts.dangling, 1);
  });

  it("tallies every status", () => {
    const rUsed = record();
    const rSpent = record({ fingerprint: "v1:fp:B" });
    const rDangling = record({ fingerprint: "v1:fp:C" });
    const rExpired = record({ fingerprint: "v1:fp:D", type: "temporary", expires: "2000-01-01" });
    const out = coverExceptions({
      head: [
        suppression(),
        suppression({ disposition: "existing", fingerprint: "v1:fp:B" }),
      ],
      records: [rUsed, rSpent, rDangling, rExpired],
      now: NOW,
    });
    assert.equal(out.counts.used, 1);
    assert.equal(out.counts.spent, 1);
    assert.equal(out.counts.dangling, 1);
    assert.equal(out.counts.expired, 1);
  });
});

describe("registry: verification", () => {
  it("fails closed when the record's file does not match the suppression", () => {
    assert.throws(
      () =>
        coverExceptions({
          head: [suppression()],
          records: [record({ file: "other.js" })],
          now: NOW,
        }),
      (err) => err instanceof PocketZipperError && err.code === "CONFIG_ERROR",
    );
  });
});
