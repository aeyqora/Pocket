import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderReport, type ReportOptions } from "../src/report.js";
import type {
  EvaluationRecord,
  InventoryEntry,
  Mode,
  Verdict,
} from "../src/types.js";

interface RecordOverrides {
  verdict?: Verdict;
  mode?: Mode;
  dispositions?: Partial<EvaluationRecord["summary"]["dispositions"]>;
  newDebt?: Partial<EvaluationRecord["summary"]["newDebt"]>;
  cleanup?: Partial<EvaluationRecord["summary"]["cleanup"]>;
  inventory?: InventoryEntry[];
}

function record(overrides: RecordOverrides = {}): EvaluationRecord {
  return {
    schemaVersion: 1,
    tool: { name: "pocket-zipper", version: "0.1.0" },
    mode: overrides.mode ?? "check",
    verdict: overrides.verdict ?? "pass",
    baseline: { ref: "main", tree: "a".repeat(40) },
    proposedChange: { ref: "HEAD", tree: "b".repeat(40) },
    summary: {
      policy: { enabled: true, allowlist: null },
      governedRules: ["no-console"],
      dispositions: {
        existing: 0,
        movedExisting: 0,
        removed: 0,
        new: 0,
        materiallyChanged: 0,
        ...overrides.dispositions,
      },
      newDebt: { authorized: 0, unauthorized: 0, ...overrides.newDebt },
      cleanup: {
        danglingExceptions: 0,
        spentExceptions: 0,
        expiredExceptions: 0,
        overlongExceptions: 0,
        poolCounts: [],
        ...overrides.cleanup,
      },
    },
    inventory: overrides.inventory ?? [],
    exceptions: [],
    errors: [],
  };
}

const authorizedEntry: InventoryEntry = {
  fingerprint: "v1:sha256:x",
  rule: "no-console",
  suppressionType: "next-line",
  guardKind: "directive",
  disposition: "new",
  file: "app.js",
  lines: { baseline: null, head: 2 },
  exception: {
    fingerprint: "v1:sha256:x",
    suppressionType: "next-line",
    rule: "no-console",
  },
};

const authorizedPass = {
  dispositions: { new: 1 },
  newDebt: { authorized: 1 },
  inventory: [authorizedEntry],
};

// This is the one deliberate unit seam: the TTY branch is selected by
// `process.stdout.isTTY`, which a piped CLI subprocess can never set, so the
// colour/no-colour decision is only observable by calling the renderer direct.
describe("TTY-aware human report", () => {
  it("colors only when stdout is a TTY", () => {
    assert.match(
      renderReport(record({ verdict: "fail" }), { verbose: false, tty: true }),
      /\u001b\[/,
    );
    assert.doesNotMatch(
      renderReport(record({ verdict: "fail" }), { verbose: false, tty: false }),
      /\u001b\[/,
    );
  });
});

describe("the fail report's remediation block", () => {
  const flagged: InventoryEntry = { ...authorizedEntry, exception: null };

  function block(options: Partial<ReportOptions> = {}): string {
    return renderReport(
      record({ verdict: "fail", newDebt: { unauthorized: 1 }, inventory: [flagged] }),
      { verbose: false, tty: false, ...options },
    );
  }

  it("prints the record's field set with a machine-prefilled line", () => {
    const out = block();
    assert.match(out, /remediate with:/);
    assert.match(out, /- rule: no-console/);
    assert.match(out, /^ {6}suppression_type: next-line$/m);
    assert.match(out, /^ {6}file: app\.js$/m);
    assert.match(out, /^ {6}type: temporary$/m);
    assert.match(out, /^ {6}reason: <why this suppression is necessary>$/m);
    assert.match(out, /^ {6}reference: <issue or PR link>$/m);
    assert.match(out, /^ {6}line: 2$/m);
  });

  it("no longer prints an owner field", () => {
    assert.doesNotMatch(block(), /owner/);
  });

  it("suggests the concrete expiry the policy resolved", () => {
    assert.match(block({ suggestedExpiry: "2026-10-14" }), /^ {6}expires: 2026-10-14$/m);
  });

  it("prints the record's fields in the registry's canonical order", () => {
    // `remediationFields` and the loader's known-field list are two spellings of
    // the record's field order; this keeps them from drifting apart.
    const out = block({ suggestedExpiry: "2026-10-14" });
    // The first field carries the YAML list marker, the rest are indented under it.
    const printed = [...out.matchAll(/^ {4}- (\w+):|^ {6}(\w+):/gm)].map((m) => m[1] ?? m[2]!);
    assert.deepEqual(printed, [
      "rule",
      "suppression_type",
      "fingerprint",
      "file",
      "type",
      "reason",
      "reference",
      "expires",
      "line",
    ]);
  });
});

describe("pass report detail (--verbose)", () => {
  it("keeps a plain check pass to one verdict line", () => {
    assert.equal(
      renderReport(record({ ...authorizedPass, cleanup: { danglingExceptions: 1 } }), {
        verbose: false,
        tty: false,
      }),
      "pocket-zipper: PASS\n",
    );
  });

  it("stays silent on a plain pre-commit pass", () => {
    assert.equal(
      renderReport(record({ mode: "pre-commit", ...authorizedPass }), {
        verbose: false,
        tty: false,
      }),
      "",
    );
  });

  it("surfaces the disposition summary on a verbose pass", () => {
    const out = renderReport(
      record({ dispositions: { existing: 2, movedExisting: 1, removed: 3 } }),
      { verbose: true, tty: false },
    );
    assert.match(
      out,
      /existing: 2\s+moved-existing: 1\s+removed: 3\s+new: 0\s+materially-changed: 0/,
    );
  });

  it("lists authorized new debt on a verbose pass", () => {
    const out = renderReport(record(authorizedPass), { verbose: true, tty: false });
    assert.match(out, /New suppression debt authorized by exception:/);
    assert.match(out, /app\.js:2\s+no-console\s+\(next-line\)/);
  });

  it("lists exception cleanup on a verbose pass", () => {
    const out = renderReport(
      record({ cleanup: { danglingExceptions: 1, expiredExceptions: 2 } }),
      { verbose: true, tty: false },
    );
    assert.match(out, /Unused exceptions: dangling 1, spent 0, expired 2/);
  });

  it("omits the cleanup line when there is no cleanup debt", () => {
    const out = renderReport(record(authorizedPass), { verbose: true, tty: false });
    assert.doesNotMatch(out, /Unused exceptions/);
  });

  it("renders the same detail in both modes under --verbose", () => {
    const checkOut = renderReport(
      record({ mode: "check", ...authorizedPass }),
      { verbose: true, tty: false },
    );
    const preCommitOut = renderReport(
      record({ mode: "pre-commit", ...authorizedPass }),
      { verbose: true, tty: false },
    );
    assert.equal(preCommitOut, checkOut);
  });
});

/**
 * The per-pool count line, which is the whole point of computing allocation as
 * a consuming count: a reader who is looking at a pool of records needs the
 * three numbers, not an inference from which suppressions came out authorized.
 */
describe("the per-pool count line", () => {
  const onePool = {
    cleanup: {
      poolCounts: [{ rule: "no-console", file: "app.js", matched: 1, used: 1, leftover: 0 }],
    },
  };

  it("prints on a fail, without --verbose", () => {
    const out = renderReport(
      record({ ...onePool, verdict: "fail", newDebt: { unauthorized: 1 } }),
      { verbose: false, tty: false },
    );
    assert.match(out, /^For this rule at this file: 1 matching records, 1 used, 0 leftover$/m);
  });

  it("prints on a verbose pass", () => {
    const out = renderReport(record({ ...onePool, verdict: "pass" }), { verbose: true, tty: false });
    assert.match(out, /^For this rule at this file: 1 matching records, 1 used, 0 leftover$/m);
  });

  it("stays off a quiet pass, where the pool is nobody's problem", () => {
    assert.equal(
      renderReport(record(onePool), { verbose: false, tty: false }),
      "pocket-zipper: PASS\n",
    );
  });

  it("prints one line per pool, in the record's order", () => {
    const out = renderReport(
      record({
        verdict: "fail",
        newDebt: { unauthorized: 1 },
        cleanup: {
          poolCounts: [
            { rule: "no-debugger", file: "old.js", matched: 1, used: 1, leftover: 0 },
            { rule: "no-console", file: "app.js", matched: 2, used: 1, leftover: 1 },
            // A pool with no records at all is the shortfall, and the count
            // line is the sentence that says so: 0 of 0, with 1 unaccounted
            // for in the report's own flagged-debt block.
            { rule: "no-console", file: "tools.js", matched: 0, used: 0, leftover: 0 },
          ],
        },
      }),
      { verbose: false, tty: false },
    );
    assert.deepEqual(
      out.split("\n").filter((line) => line.startsWith("For this rule at this file")),
      [
        "For this rule at this file: 1 matching records, 1 used, 0 leftover",
        "For this rule at this file: 2 matching records, 1 used, 1 leftover",
        "For this rule at this file: 0 matching records, 0 used, 0 leftover",
      ],
    );
  });

  it("prints nothing when the record carries no pools", () => {
    const out = renderReport(
      record({ verdict: "fail", newDebt: { unauthorized: 1 } }),
      { verbose: false, tty: false },
    );
    assert.doesNotMatch(out, /For this rule at this file/);
  });
});

/**
 * The overlong-exceptions line: the count of baseline records whose expiry is
 * past the resolved maximum, printed beside the unused-exceptions block. The
 * maximum travels through `ReportOptions` the way `suggestedExpiry` does —
 * the pipeline resolves policy, the renderer prints.
 */
describe("the overlong-exceptions line", () => {
  it("prints on a fail, naming the maximum", () => {
    const out = renderReport(
      record({ verdict: "fail", newDebt: { unauthorized: 1 }, cleanup: { overlongExceptions: 1 } }),
      { verbose: false, tty: false, maxExpiry: "3mo" },
    );
    assert.match(out, /^  Overlong exceptions: 1 \(expires past the 3mo maximum\)$/m);
  });

  it("prints on a verbose pass", () => {
    const out = renderReport(
      record({ cleanup: { overlongExceptions: 1 } }),
      { verbose: true, tty: false, maxExpiry: "3mo" },
    );
    assert.match(out, /^  Overlong exceptions: 1 \(expires past the 3mo maximum\)$/m);
  });

  it("stays off a quiet pass, and off a record with none overlong", () => {
    assert.equal(
      renderReport(record({ cleanup: { overlongExceptions: 1 } }), {
        verbose: false,
        tty: false,
        maxExpiry: "3mo",
      }),
      "pocket-zipper: PASS\n",
    );
    // A nonzero unused-exceptions tally does not drag the overlong line along:
    // the overlong count is its own sentence, present only when it is nonzero.
    const otherCleanup = renderReport(
      record({ cleanup: { danglingExceptions: 1 } }),
      { verbose: true, tty: false, maxExpiry: "3mo" },
    );
    assert.match(otherCleanup, /Unused exceptions: dangling 1, spent 0, expired 0/);
    assert.doesNotMatch(otherCleanup, /Overlong exceptions/);
  });
});
