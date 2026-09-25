import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coverExceptions, parseRegistry, recordMatchKey } from "../src/registry.js";
import type { ExceptionRecord, ReconciledSuppression } from "../src/types.js";

const NOW = new Date("2026-09-14T12:00:00Z");
const FP_NC = "v1:fp:no-console";

/** A temporary record with every optional field absent. */
const MINIMAL_TEMPORARY = [
  "- rule: no-console",
  "  suppression_type: next-line",
  `  fingerprint: ${FP_NC}`,
  "  file: app.js",
  "  type: temporary",
  "  reason: needed",
  "  expires: 2099-01-01",
  "",
].join("\n");

/** The same record as a permanent one: no `expires`, no `line`. */
const MINIMAL_PERMANENT = MINIMAL_TEMPORARY.replace(
  "  type: temporary\n  reason: needed\n  expires: 2099-01-01\n",
  "  type: permanent\n  reason: needed\n",
);

/**
 * The registry's own diagnostic for a defective document, asserted the way
 * `assertConfigError` asserts the policy's: `CONFIG_ERROR` first, then the
 * message.
 */
function defectMessage(raw: string): string {
  try {
    parseRegistry(raw);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    assert.equal(e.code, "CONFIG_ERROR");
    return e.message ?? "";
  }
  return assert.fail(`expected ${raw} to be a defect`);
}

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
    reference: "#1",
    ...overrides,
  };
}

describe("registry: record shape", () => {
  it("reads a permanent record carrying no owner", () => {
    const [r] = parseRegistry(MINIMAL_PERMANENT + "  reference: '#1'\n");
    assert.deepEqual(r, {
      rule: "no-console",
      suppression_type: "next-line",
      fingerprint: FP_NC,
      file: "app.js",
      type: "permanent",
      reason: "needed",
      reference: "#1",
    });
  });

  it("fails closed on a stale owner, naming the removed field and the fix", () => {
    const stale = MINIMAL_TEMPORARY.replace(
      "  reason: needed",
      "  reason: needed\n  owner: '@team'",
    );
    assert.match(
      defectMessage(stale),
      /unknown field 'owner' — removed from the registry format; delete this line/,
    );
  });

  it("reads an optional integer line and keeps it out of the match key", () => {
    const [r] = parseRegistry(MINIMAL_TEMPORARY + "  line: 7\n");
    assert.equal(r?.line, 7);
    assert.equal(recordMatchKey(r!), recordMatchKey(parseRegistry(MINIMAL_TEMPORARY)[0]!));
  });

  it("omits line entirely when undeclared", () => {
    const [r] = parseRegistry(MINIMAL_TEMPORARY);
    assert.equal(r?.line, undefined);
  });

  it("rejects a line that is not an integer of at least 1", () => {
    for (const value of ["0", "-3", "2.5", "abc"]) {
      assert.match(
        defectMessage(MINIMAL_TEMPORARY + `  line: ${value}\n`),
        /'line'/,
        `line: ${value}`,
      );
    }
  });

  it("rejects an unknown field, naming the field and the known set", () => {
    const message = defectMessage(MINIMAL_TEMPORARY + "  ticket: '#2'\n");
    assert.match(message, /unknown field 'ticket'/);
    assert.match(message, /known fields are rule, suppression_type, fingerprint/);
  });

  it("requires expires on a temporary and forbids it on a permanent", () => {
    assert.equal(parseRegistry(MINIMAL_PERMANENT)[0]?.type, "permanent");
    assert.match(
      defectMessage(MINIMAL_TEMPORARY.replace("  expires: 2099-01-01\n", "")),
      /'expires'/,
    );
    assert.match(defectMessage(MINIMAL_PERMANENT + "  expires: 2099-01-01\n"), /'expires'/);
  });

  it("hands on exactly the known field set, in the canonical order", () => {
    assert.deepEqual(
      Object.keys(parseRegistry(MINIMAL_TEMPORARY + "  line: 7\n")[0]!),
      [
        "rule",
        "suppression_type",
        "fingerprint",
        "file",
        "type",
        "reason",
        "expires",
        "line",
      ],
    );
  });
});

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

  it("does not authorize on a mismatched fingerprint, rule, type, or file", () => {
    for (const r of [
      record({ fingerprint: `v1:sha256:${"0".repeat(64)}` }),
      record({ rule: "no-debugger" }),
      record({ suppression_type: "line" }),
      record({ file: "other.js" }),
    ]) {
      const out = coverExceptions({ head: [suppression()], records: [r], now: NOW });
      assert.equal(out.head[0]!.exception, null);
      assert.equal(out.statuses.get(r), "dangling");
    }
  });

  it("leaves a materially-changed suppression in another file unauthorized", () => {
    const r = record({ file: "other.js" });
    const out = coverExceptions({
      head: [suppression({ disposition: "materially-changed" })],
      records: [r],
      now: NOW,
    });
    assert.equal(out.head[0]!.exception, null);
    assert.equal(out.statuses.get(r), "dangling");
  });

  it("authorizes from the record scoped to the suppression's file among lookalikes", () => {
    const elsewhere = record({ file: "other.js" });
    const here = record();
    const out = coverExceptions({
      head: [suppression()],
      records: [elsewhere, here],
      now: NOW,
    });
    assert.equal(out.head[0]!.exception?.fingerprint, FP_NC);
    assert.equal(out.statuses.get(here), "used");
    assert.equal(out.statuses.get(elsewhere), "dangling");
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

  it("reports a record whose suppression moved within its file as spent", () => {
    const r = record();
    const out = coverExceptions({
      head: [suppression({ disposition: "moved-existing", line: 12 })],
      records: [r],
      now: NOW,
    });
    assert.equal(out.statuses.get(r), "spent");
    assert.equal(out.counts.spent, 1);
  });

  it("does not let an existing suppression in another file spend the record", () => {
    const r = record();
    const out = coverExceptions({
      head: [suppression({ disposition: "existing", file: "legacy.js" })],
      records: [r],
      now: NOW,
    });
    assert.equal(out.statuses.get(r), "dangling");
    assert.equal(out.counts.dangling, 1);
    assert.equal(out.counts.spent, 0);
  });

  it("does not let a moved-existing suppression in another file spend the record", () => {
    const r = record();
    const out = coverExceptions({
      head: [suppression({ disposition: "moved-existing", file: "legacy.js" })],
      records: [r],
      now: NOW,
    });
    assert.equal(out.statuses.get(r), "dangling");
    assert.equal(out.counts.dangling, 1);
    assert.equal(out.counts.spent, 0);
  });

  it("spends a record when a same-file match exists alongside one in another file", () => {
    const r = record();
    const out = coverExceptions({
      head: [
        suppression({ disposition: "existing", file: "legacy.js" }),
        suppression({ disposition: "moved-existing", line: 12 }),
      ],
      records: [r],
      now: NOW,
    });
    assert.equal(out.statuses.get(r), "spent");
    assert.equal(out.counts.spent, 1);
  });

  it("reports expired ahead of dangling or spent regardless of file match", () => {
    for (const disposition of ["existing", "moved-existing"] as const) {
      for (const file of ["app.js", "legacy.js"]) {
        const r = record({ type: "temporary", expires: "2000-01-01" });
        const out = coverExceptions({
          head: [suppression({ disposition, file })],
          records: [r],
          now: NOW,
        });
        assert.equal(out.statuses.get(r), "expired", `${disposition} in ${file}`);
      }
    }
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

  it("keeps an expired record expired when its lookalike lands in another file", () => {
    const r = record({ type: "temporary", expires: "2000-01-01", file: "other.js" });
    const out = coverExceptions({ head: [suppression()], records: [r], now: NOW });
    assert.equal(out.head[0]!.exception, null);
    assert.equal(out.statuses.get(r), "expired");
    assert.equal(out.counts.expired, 1);
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
