import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderReport } from "../src/report.js";
import type { EvaluationRecord, Verdict } from "../src/types.js";

function record(verdict: Verdict): EvaluationRecord {
  return {
    schemaVersion: 1,
    tool: { name: "pocket-zipper", version: "0.1.0" },
    mode: "check",
    verdict,
    baseline: { ref: "main", tree: "a".repeat(40) },
    proposedChange: { ref: "HEAD", tree: "b".repeat(40) },
    summary: {
      policy: { enabled: true, allowlist: null },
      governedRules: ["no-console"],
      dispositions: { existing: 0, movedExisting: 0, removed: 0, new: 1, materiallyChanged: 0 },
      newDebt: { authorized: 0, unauthorized: 1 },
      cleanup: { danglingExceptions: 0, spentExceptions: 0, expiredExceptions: 0 },
    },
    inventory: [
      {
        fingerprint: "v1:sha256:x",
        rule: "no-console",
        suppressionType: "next-line",
        guardKind: "directive",
        disposition: "new",
        file: "app.js",
        lines: { baseline: null, head: 2 },
        exception: null,
      },
    ],
    exceptions: [],
    errors: [],
  };
}

// This is the one deliberate unit seam: the TTY branch is selected by
// `process.stdout.isTTY`, which a piped CLI subprocess can never set, so the
// colour/no-colour decision is only observable by calling the renderer direct.
describe("TTY-aware human report", () => {
  it("colors only when stdout is a TTY", () => {
    assert.match(renderReport(record("fail"), { verbose: false, tty: true }), /\u001b\[/);
    assert.doesNotMatch(
      renderReport(record("fail"), { verbose: false, tty: false }),
      /\u001b\[/,
    );
  });
});
