import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/reconcile.js";
import type { LineDiff } from "../src/identity.js";
import type { LogicalSuppression } from "../src/types.js";

const NC = "v1:fp:no-console";
const ND = "v1:fp:no-debugger";

function supp(overrides: Partial<LogicalSuppression> = {}): LogicalSuppression {
  const rule = overrides.rule ?? "no-console";
  return {
    fingerprint: NC,
    rule,
    suppressionType: "next-line",
    guardKind: "directive",
    file: "app.js",
    line: 1,
    guardStart: 2,
    guardEnd: 2,
    guardedContent: "",
    justification: "",
    canonicalText: "",
    namedRules: [rule],
    ...overrides,
  };
}

function run(
  head: LogicalSuppression[],
  baseline: LogicalSuppression[],
  opts: {
    lineDiffs?: Map<string, LineDiff>;
    baselineIndex?: Set<string>;
    headIndex?: Set<string>;
  } = {},
) {
  return reconcile({
    headSuppressions: head,
    baselineSuppressions: baseline,
    lineDiffs: opts.lineDiffs ?? new Map(),
    baselineIndex: opts.baselineIndex ?? new Set(),
    headIndex: opts.headIndex ?? new Set(),
  });
}

function diff(added: number[], removed: number[]): Map<string, LineDiff> {
  return new Map([["app.js", { addedHead: new Set(added), removedBase: new Set(removed) }]]);
}

describe("reconcile: continuity dispositions", () => {
  it("marks a same-path, same-position twin as existing", () => {
    const out = run([supp({ line: 5, guardStart: 6 })], [supp({ line: 5, guardStart: 6 })]);
    assert.equal(out.head[0]!.disposition, "existing");
    assert.equal(out.head[0]!.baselineLine, 5);
    assert.equal(out.removed.length, 0);
  });

  it("marks a drifted position as moved-existing", () => {
    const out = run([supp({ line: 9, guardStart: 10 })], [supp({ line: 5, guardStart: 6 })]);
    assert.equal(out.head[0]!.disposition, "moved-existing");
    assert.equal(out.head[0]!.baselineLine, 5);
  });

  it("marks an unmatched head new and an unmatched baseline removed", () => {
    const out = run(
      [supp({ fingerprint: NC })],
      [supp({ fingerprint: ND, rule: "no-debugger" })],
    );
    assert.equal(out.head[0]!.disposition, "new");
    assert.equal(out.head[0]!.baselineLine, null);
    assert.equal(out.head[0]!.exception, null);
    assert.equal(out.removed.length, 1);
    assert.equal(out.removed[0]!.fingerprint, ND);
  });

  it("allocates a fungible pool greedily by guard context, never by line", () => {
    const baseline = [
      supp({ line: 2, guardStart: 3, guardedContent: 'console.log("a")' }),
      supp({ line: 6, guardStart: 7, guardedContent: 'console.log("b")' }),
    ];
    const head = [
      supp({ line: 10, guardStart: 11, guardedContent: 'console.log("b")' }),
      supp({ line: 14, guardStart: 15, guardedContent: 'console.log("a")' }),
    ];
    const out = run(head, baseline);
    const byLine = new Map(out.head.map((e) => [e.line, e.baselineLine]));
    assert.equal(byLine.get(10), 6);
    assert.equal(byLine.get(14), 2);
    assert.ok(out.head.every((e) => e.disposition === "moved-existing"));
  });

  it("orders output deterministically by file, then line, then rule", () => {
    const out = run(
      [supp({ file: "z.js", line: 1 }), supp({ file: "a.js", line: 9 })],
      [],
    );
    assert.deepEqual(out.head.map((e) => e.file), ["a.js", "z.js"]);
  });

  it("keeps multi-rule directives independent", () => {
    const out = run(
      [
        supp({ rule: "no-console", fingerprint: NC, line: 3, guardStart: 4 }),
        supp({ rule: "no-debugger", fingerprint: ND, line: 8, guardStart: 9 }),
      ],
      [supp({ rule: "no-console", fingerprint: NC })],
    );
    assert.equal(out.head.find((e) => e.rule === "no-console")!.disposition, "moved-existing");
    assert.equal(out.head.find((e) => e.rule === "no-debugger")!.disposition, "new");
  });
});

describe("reconcile: the tomb rule", () => {
  const dead = supp({ line: 2, guardStart: 3, guardedContent: 'console.log("dead")' });
  const newborn = supp({ line: 10, guardStart: 11, guardedContent: 'console.log("brand-new")' });
  const tombDiff = diff([9], [2]);

  it("marks newborn comment + removed twin + new statement + dead twin as materially-changed", () => {
    const out = run([newborn], [dead], { lineDiffs: tombDiff });
    assert.equal(out.head[0]!.disposition, "materially-changed");
    assert.equal(out.head[0]!.baselineLine, 2);
  });

  it("does not tomb when the twin's guarded statement survives in the head", () => {
    const out = run([newborn], [dead], {
      lineDiffs: tombDiff,
      headIndex: new Set(['console.log("dead")']),
    });
    assert.notEqual(out.head[0]!.disposition, "materially-changed");
  });

  it("does not tomb when the head's guarded statement already exists in the baseline", () => {
    const out = run([newborn], [dead], {
      lineDiffs: tombDiff,
      baselineIndex: new Set(['console.log("brand-new")']),
    });
    assert.notEqual(out.head[0]!.disposition, "materially-changed");
  });

  it("does not tomb an in-place rewrite where the comment is unchanged", () => {
    const out = run(
      [supp({ line: 5, guardStart: 6, guardedContent: 'console.log("new")' })],
      [supp({ line: 5, guardStart: 6, guardedContent: 'console.log("old")' })],
      { lineDiffs: diff([], [5]) },
    );
    assert.equal(out.head[0]!.disposition, "existing");
  });

  it("never tomb-classifies region forms", () => {
    const out = run(
      [
        supp({
          suppressionType: "block",
          line: 10,
          guardStart: 11,
          guardEnd: 16,
          guardedContent: 'console.log("brand-new")',
        }),
      ],
      [
        supp({
          suppressionType: "block",
          line: 2,
          guardStart: 3,
          guardEnd: 8,
          guardedContent: 'console.log("dead")',
        }),
      ],
      { lineDiffs: tombDiff },
    );
    assert.notEqual(out.head[0]!.disposition, "materially-changed");
  });
});
