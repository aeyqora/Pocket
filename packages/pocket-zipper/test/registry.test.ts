import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coverExceptions, expiryPolicyRefusals } from "../src/registry.js";
import { recordMatchKey } from "../src/exception-match.js";
import { loadRegistry } from "../src/validate.js";
import { addDuration } from "../src/policy.js";
import type { ExceptionRecord, ReconciledSuppression } from "../src/types.js";

const NOW = new Date("2026-09-14T12:00:00Z");
const TODAY_UTC = NOW.toISOString().slice(0, 10);

/** A well-formed fingerprint: the format check is a separate concern from matching. */
const FP_NC = `v1:sha256:${"a".repeat(64)}`;

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
 * message — which is every defect's diagnostic line, joined.
 */
function defectMessage(raw: string): string {
  try {
    loadRegistry(raw);
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

/**
 * N same-file twin suppressions: one match key, N distinct places in the file.
 * Two identical directives share a fingerprint, so a pool is a *count*, and
 * these are the units it consumes. Lines are spaced so a reader can tell the
 * twins apart at a glance — a line is never what makes one of them match.
 */
function twins(n: number): ReconciledSuppression[] {
  return Array.from({ length: n }, (_, i) =>
    suppression({ line: 10 + i * 2, guardStart: 11 + i * 2, guardEnd: 11 + i * 2 }),
  );
}

/** N records for one twin pool, distinct objects so statuses key by identity. */
function twinRecords(n: number, overrides: Partial<ExceptionRecord> = {}): ExceptionRecord[] {
  return Array.from({ length: n }, () => record(overrides));
}

describe("registry: record shape", () => {
  it("reads a permanent record carrying no owner", () => {
    const [r] = loadRegistry(MINIMAL_PERMANENT + "  reference: '#1'\n");
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
    const [r] = loadRegistry(MINIMAL_TEMPORARY + "  line: 7\n");
    assert.equal(r?.line, 7);
    assert.equal(recordMatchKey(r!), recordMatchKey(loadRegistry(MINIMAL_TEMPORARY)[0]!));
  });

  it("omits line entirely when undeclared", () => {
    const [r] = loadRegistry(MINIMAL_TEMPORARY);
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
    assert.equal(loadRegistry(MINIMAL_PERMANENT)[0]?.type, "permanent");
    assert.match(
      defectMessage(MINIMAL_TEMPORARY.replace("  expires: 2099-01-01\n", "")),
      /'expires'/,
    );
    assert.match(defectMessage(MINIMAL_PERMANENT + "  expires: 2099-01-01\n"), /'expires'/);
  });

  it("hands on exactly the known field set, in the canonical order", () => {
    assert.deepEqual(
      Object.keys(loadRegistry(MINIMAL_TEMPORARY + "  line: 7\n")[0]!),
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

  it("builds no pool for a new config-off, which no record could ever cover", () => {
    // A config-off reconciles to `new` like any unpaired suppression, so the
    // disposition alone would admit it. It is a policy change, not new debt:
    // its `suppression_type` is in the match key and no record may name one, so
    // a pool built from it would report `0, 0, 0` forever — a count line
    // reading "nothing leftover" about a record that could never have been used.
    const configOff = suppression({
      rule: "no-console",
      suppressionType: "config-off",
      guardKind: "config-level",
      file: "eslint.config.mjs",
    });
    assert.equal(configOff.disposition, "new");

    const out = coverExceptions({ head: [configOff], records: [record()], now: NOW });
    assert.deepEqual(out.pools, []);
    assert.equal(out.head[0]!.exception, null);
  });

  it("still builds a pool for a new directive, the case the count line is for", () => {
    const out = coverExceptions({ head: [suppression()], records: [], now: NOW });
    assert.equal(out.pools.length, 1);
    assert.equal(out.pools[0]!.matched, 0);
    assert.equal(out.pools[0]!.used, 0);
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

/**
 * Allocation as a consuming count. Every test here fixes N records and M
 * suppressions and asserts what an author can observe — how many suppressions
 * came out carrying an `exception`, what each record is classified as, and the
 * pool's three counts. Which record authorized *which* twin is deliberately
 * not asserted: that is the internal pairing order, and pinning it would make
 * a correct re-pairing look like a regression.
 */
describe("registry: allocation as a consuming count", () => {
  it("gives each twin its own record, and no record two twins", () => {
    const [first, second] = twinRecords(2);
    const out = coverExceptions({ head: twins(2), records: [first, second], now: NOW });
    assert.deepEqual(out.head.map((h) => h.exception !== null), [true, true]);
    assert.equal(out.statuses.get(first), "used");
    assert.equal(out.statuses.get(second), "used");
    assert.deepEqual(out.counts, { used: 2, expired: 0, dangling: 0, spent: 0 });
    assert.deepEqual(out.pools, [
      { rule: "no-console", file: "app.js", matched: 2, used: 2, leftover: 0 },
    ]);
    // Authorized twins carry the identical match-fields-only reference: the
    // fields a record is matched on, and nothing else — no file, no line.
    assert.deepEqual(out.head.map((h) => h.exception), [
      { fingerprint: FP_NC, suppressionType: "next-line", rule: "no-console" },
      { fingerprint: FP_NC, suppressionType: "next-line", rule: "no-console" },
    ]);
  });

  it("authorizes at most one suppression per record", () => {
    const [only] = twinRecords(1);
    const out = coverExceptions({ head: twins(2), records: [only], now: NOW });
    assert.deepEqual(out.head.map((h) => h.exception !== null), [true, false]);
    assert.equal(out.statuses.get(only), "used");
    assert.deepEqual(out.counts, { used: 1, expired: 0, dangling: 0, spent: 0 });
    // The pool's arithmetic counts records, not suppressions: one record, one
    // used, nothing surplus. The second twin's missing exception is not a leftover
    // record — it is a suppression no record covers, and the head line above is
    // what reports that, not this one.
    assert.deepEqual(out.pools, [
      { rule: "no-console", file: "app.js", matched: 1, used: 1, leftover: 0 },
    ]);
  });

  it("reads a surplus record dangling, with the pool showing the leftover", () => {
    const [used, surplus] = twinRecords(2);
    const out = coverExceptions({ head: twins(1), records: [used, surplus], now: NOW });
    assert.equal(out.statuses.get(used), "used");
    assert.equal(out.statuses.get(surplus), "dangling");
    assert.deepEqual(out.counts, { used: 1, expired: 0, dangling: 1, spent: 0 });
    assert.deepEqual(out.pools, [
      { rule: "no-console", file: "app.js", matched: 2, used: 1, leftover: 1 },
    ]);
  });

  it("reads every surplus record dangling, not just the first one", () => {
    // Dangling means no *unclaimed* matching suppression remains, so the claim
    // itself is what orphans a sibling: the lone twin is covered, and both
    // surplus records read dangling rather than spent or still in use.
    const [used, ...surplus] = twinRecords(3);
    const out = coverExceptions({ head: twins(1), records: [used, ...surplus], now: NOW });
    assert.equal(out.statuses.get(used), "used");
    for (const record of surplus) assert.equal(out.statuses.get(record), "dangling");
    assert.deepEqual(out.counts, { used: 1, expired: 0, dangling: 2, spent: 0 });
    assert.deepEqual(out.pools, [
      { rule: "no-console", file: "app.js", matched: 3, used: 1, leftover: 2 },
    ]);
  });

  it("allocates the same way whatever the twins' guarded content looks like", () => {
    // Two twins guarding code that shares no tokens, so a content-similarity
    // ranking would put one unambiguously first. The continuity matcher's
    // guard-context tie-break is for baseline↔head continuity and never
    // reorders record allocation, so which twin is "first" cannot change the
    // outcome — asserted by running the pool in both orders.
    const alpha = suppression({
      line: 10,
      guardStart: 11,
      guardEnd: 11,
      guardedContent: "render(window.location.href);",
    });
    const beta = suppression({
      line: 12,
      guardStart: 13,
      guardEnd: 13,
      guardedContent: "export const result = compute(alpha, beta);",
    });
    const [first, second] = twinRecords(2);
    for (const head of [
      [alpha, beta],
      [beta, alpha],
    ]) {
      const out = coverExceptions({ head, records: [first, second], now: NOW });
      assert.deepEqual(out.head.map((h) => h.exception !== null), [true, true]);
      assert.equal(out.statuses.get(first), "used");
      assert.equal(out.statuses.get(second), "used");
      assert.deepEqual(out.pools, [
        { rule: "no-console", file: "app.js", matched: 2, used: 2, leftover: 0 },
      ]);
    }
  });

  it("never lets YAML order decide whether an expired sibling costs a twin", () => {
    const expired = record({ type: "temporary", expires: "2000-01-01" });
    const valid = record();
    // The pool holds one expired record and one valid one; which of them the
    // document writes first is a formatting accident, so both orders must read
    // the same. An expired record reserves no slot, so the valid sibling
    // authorizes past it and the lone twin is covered either way — today the
    // first order hands the twin to the expired record, which authorizes
    // nothing, and loses it.
    for (const records of [
      [expired, valid],
      [valid, expired],
    ]) {
      const out = coverExceptions({ head: twins(1), records, now: NOW });
      assert.deepEqual(out.head.map((h) => h.exception !== null), [true], "the twin");
      assert.equal(out.statuses.get(expired), "expired");
      assert.equal(out.statuses.get(valid), "used");
      assert.deepEqual(out.counts, { used: 1, expired: 1, dangling: 0, spent: 0 });
      // The expired record is not in the pool's arithmetic: it could never
      // reserve a slot, so the pool is one of one with nothing left over.
      assert.deepEqual(out.pools, [
        { rule: "no-console", file: "app.js", matched: 1, used: 1, leftover: 0 },
      ]);
    }
  });

  it("leaves every twin past the record count unauthorized", () => {
    const [only] = twinRecords(1);
    const out = coverExceptions({ head: twins(3), records: [only], now: NOW });
    // The excess twins carry no exception reference, which is what the record's
    // own summary reads as unauthorized new debt.
    assert.deepEqual(out.head.map((h) => h.exception !== null), [true, false, false]);
    assert.equal(out.statuses.get(only), "used");
    assert.deepEqual(out.counts, { used: 1, expired: 0, dangling: 0, spent: 0 });
    assert.deepEqual(out.pools, [
      { rule: "no-console", file: "app.js", matched: 1, used: 1, leftover: 0 },
    ]);
  });

  it("prefers a claimable twin over pre-existing debt, and reports no pool without one", () => {
    const [claiming] = twinRecords(1);
    const claimed = coverExceptions({
      head: [suppression(), suppression({ disposition: "existing", line: 20 })],
      records: [claiming],
      now: NOW,
    });
    // The new twin is authorized, so the record is in use — a pool holding
    // pre-existing debt as well is not a pool where the record reads spent.
    assert.equal(claimed.statuses.get(claiming), "used");
    assert.equal(claimed.counts.used, 1);
    assert.equal(claimed.counts.spent, 0);
    assert.deepEqual(claimed.pools, [
      { rule: "no-console", file: "app.js", matched: 1, used: 1, leftover: 0 },
    ]);

    const [unclaimable] = twinRecords(1);
    const spent = coverExceptions({
      head: [suppression({ disposition: "existing" })],
      records: [unclaimable],
      now: NOW,
    });
    assert.equal(spent.statuses.get(unclaimable), "spent");
    // Nothing here has new debt to allocate, so the pool is not reported at
    // all: a count line about a record that is perfectly fine would only
    // misdescribe it. The spent status is the whole story.
    assert.deepEqual(spent.pools, []);
  });

  it("gives a next-line record and a block record a slot each", () => {
    // Same rule, same file, two different suppression types: two match keys,
    // so two slots. A pool keyed on (rule, file) alone would hand one of them
    // nothing and leave its suppression unauthorized.
    const nextLine = record({ suppression_type: "next-line" });
    const block = record({ suppression_type: "block" });
    const out = coverExceptions({
      head: [
        suppression({ suppressionType: "next-line" }),
        suppression({ suppressionType: "block", line: 20, guardStart: 21, guardEnd: 24 }),
      ],
      records: [nextLine, block],
      now: NOW,
    });
    assert.deepEqual(out.head.map((h) => h.exception !== null), [true, true]);
    assert.equal(out.statuses.get(nextLine), "used");
    assert.equal(out.statuses.get(block), "used");
    // Allocation is per match key, but the bookkeeping is per (rule, file):
    // two match keys under one rule and one file, aggregated into one count.
    assert.deepEqual(out.pools, [
      { rule: "no-console", file: "app.js", matched: 2, used: 2, leftover: 0 },
    ]);
  });
});

/**
 * The refusal half of the expiry policy, at the seam that owns the record's
 * semantics. The shape under test is the "newly written" rule applied to a
 * registry edit: a head record is refused iff it is a temporary past the
 * baseline horizon and no *unconsumed* baseline record shares its match key
 * and its `expires`. The consuming is a multiset — each head record takes one
 * baseline counterpart — which is the whole point: a set of keys would admit
 * unlimited extra records at a refused date.
 */
describe("registry: the expiry-policy refusal", () => {
  const MAX = "3mo";
  const BEYOND = "2099-01-01"; // past any horizon derived from NOW

  function refusalsOf(input: {
    baseline: ExceptionRecord[];
    head: ExceptionRecord[];
  }): ExceptionRecord[] {
    return expiryPolicyRefusals({ ...input, now: NOW, maxExpiry: MAX });
  }

  it("refuses a second head twin a set-based rule would admit", () => {
    const base = record({ type: "temporary", expires: BEYOND });
    const [kept, twin] = twinRecords(2, { type: "temporary", expires: BEYOND });
    // The unchanged twin consumes the baseline counterpart and is not a
    // refusal; the second twin has no counterpart left. Whichever twin the
    // document writes second is the one refused — the multiset, not the set,
    // is what shuts the add-N-more dodge down.
    assert.deepEqual(refusalsOf({ baseline: [base], head: [kept] }), []);
    assert.deepEqual(refusalsOf({ baseline: [base], head: [kept, twin] }), [twin]);
    assert.deepEqual(refusalsOf({ baseline: [base], head: [twin, kept] }), [kept]);
  });

  it("treats a file-scope repair as the same record, date and all", () => {
    // `file` is deliberately not part of the match key, so a record that moved
    // to follow a renamed file writes no new date and is not a refusal.
    const base = record({ type: "temporary", expires: BEYOND });
    const moved = record({ type: "temporary", expires: BEYOND, file: "lib/app.js" });
    assert.deepEqual(refusalsOf({ baseline: [base], head: [moved] }), []);
  });

  it("keeps a permanent out of the expiry policy entirely", () => {
    // A permanent cannot legally carry a date, so it has no expiry for the
    // policy to judge — a temporary converted in the same change included.
    const permanent = record();
    assert.deepEqual(refusalsOf({ baseline: [], head: [permanent] }), []);
    const temporary = record({ type: "temporary", expires: BEYOND });
    assert.deepEqual(refusalsOf({ baseline: [temporary], head: [permanent] }), []);
  });

  it("keeps a renewal inside the maximum quiet, and stops one past it", () => {
    // The ordinary case must stay quiet: any newly written date within the
    // horizon is fine to write, so an in-maximum renewal passes...
    const within = record({
      type: "temporary",
      expires: addDuration(TODAY_UTC, "30d"),
    });
    const renewed = record({
      type: "temporary",
      expires: addDuration(TODAY_UTC, "60d"),
    });
    assert.deepEqual(refusalsOf({ baseline: [within], head: [renewed] }), []);
    // ...and the same shape one step past the horizon is the refusal.
    const far = record({ type: "temporary", expires: BEYOND });
    assert.deepEqual(refusalsOf({ baseline: [within], head: [far] }), [far]);
  });
});
