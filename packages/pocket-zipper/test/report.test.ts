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

  it("prints the v2 field set with a machine-prefilled line", () => {
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
