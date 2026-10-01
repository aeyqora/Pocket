import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalCodeLine,
  canonicalMovementLine,
  diffLineIndices,
  pairBySimilarity,
  type SuppressionPair,
} from "../src/continuity.js";
import { fingerprintOf } from "../src/identity.js";
import type { LogicalSuppression } from "../src/types.js";

/** A suppression, with only the fields the matcher reads. */
function suppression(overrides: Partial<LogicalSuppression> = {}): LogicalSuppression {
  return {
    fingerprint: fingerprintOf("next-line\nno-console"),
    rule: "no-console",
    suppressionType: "next-line",
    guardKind: "directive",
    file: "app.js",
    line: 5,
    guardStart: 6,
    guardEnd: 6,
    guardedContent: "console.log(1)",
    justification: "",
    canonicalText: "next-line\nno-console",
    namedRules: ["no-console"],
    ...overrides,
  };
}

describe("continuity: canonicalCodeLine", () => {
  it("collapses whitespace but leaves non-directive code intact", () => {
    assert.equal(canonicalCodeLine("  foo   --   bar  "), "foo -- bar");
  });

  it("strips a directive's justification", () => {
    assert.equal(
      canonicalCodeLine("// eslint-disable-next-line no-console -- reason"),
      "// eslint-disable-next-line no-console",
    );
  });
});

describe("continuity: canonicalMovementLine", () => {
  it("strips inline code from a line-form directive", () => {
    assert.equal(
      canonicalMovementLine("console.log(1); // eslint-disable-line no-console"),
      "eslint-disable-line no-console",
    );
  });

  it("normalizes rule order and whitespace", () => {
    assert.equal(
      canonicalMovementLine("// eslint-disable-next-line no-debugger,  no-console"),
      "eslint-disable-next-line no-console,no-debugger",
    );
  });

  it("dedupes repeated rule tokens", () => {
    assert.equal(
      canonicalMovementLine("// eslint-disable-next-line no-console, no-console"),
      "eslint-disable-next-line no-console",
    );
  });

  it("handles the block-comment line form", () => {
    assert.equal(
      canonicalMovementLine("/* eslint-disable-line no-console */"),
      "eslint-disable-line no-console",
    );
  });

  it("drops a directive's justification", () => {
    assert.equal(
      canonicalMovementLine("// eslint-disable-next-line no-console -- reason"),
      "eslint-disable-next-line no-console",
    );
  });

  it("leaves region directives and plain code on the code-line path", () => {
    assert.equal(
      canonicalMovementLine("/* eslint-disable no-console */"),
      "/* eslint-disable no-console */",
    );
    assert.equal(canonicalMovementLine("  a();  "), "a();");
  });
});

describe("continuity: the code beneath a directive is not its identity", () => {
  it("pairs by guard context, never by line", () => {
    // Two directives in one file, both matching two baseline candidates. The
    // pairing is decided by which baseline guarded statement each head statement
    // resembles, so swapping the lines changes nothing.
    const head = [
      suppression({ line: 10, guardedContent: "console.log(alpha)" }),
      suppression({ line: 20, guardedContent: "console.log(beta)" }),
    ];
    const baseline = [
      suppression({ line: 99, guardedContent: "console.log(beta)" }),
      suppression({ line: 98, guardedContent: "console.log(alpha)" }),
    ];
    const pairs = pairBySimilarity(head, baseline);
    assert.equal(pairs.length, 2);
    const headOf = (content: string) =>
      pairs.find((p: SuppressionPair) => p.baseline.guardedContent === content)!.head;
    assert.equal(headOf("console.log(alpha)").guardedContent, "console.log(alpha)");
    assert.equal(headOf("console.log(beta)").guardedContent, "console.log(beta)");
    assert.notEqual(pairs[0]!.head.line, pairs[0]!.baseline.line);
  });

  it("gives each suppression at most one counterpart", () => {
    // Three identical head directives, one baseline: two must go unpaired, so the
    // count is a real number and a second baseline record cannot silently cover
    // the rest.
    const head = [1, 2, 3].map((i) =>
      suppression({ line: i, guardedContent: "console.log(1)" }),
    );
    const pairs = pairBySimilarity(head, [suppression()]);
    assert.equal(pairs.length, 1);
  });

  it("treats two empty guard contexts as a perfect match, not a zero", () => {
    const pairs = pairBySimilarity(
      [suppression({ guardedContent: "" })],
      [suppression({ guardedContent: "" })],
    );
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0]!.similarity, 1);
  });

  it("uses file before indexes when compatible candidates span files", () => {
    const pairs = pairBySimilarity(
      [
        suppression({ file: "z.js", guardedContent: "same()" }),
        suppression({ file: "a.js", guardedContent: "same()" }),
      ],
      [
        suppression({ file: "z.js", guardedContent: "same()" }),
        suppression({ file: "a.js", guardedContent: "same()" }),
      ],
      (head, baseline) => head.file === baseline.file,
    );

    assert.deepEqual(
      pairs.map((pair) => pair.head.file),
      ["a.js", "z.js"],
    );
    const byHeadFile = new Map(pairs.map((pair) => [pair.head.file, pair.baseline.file]));
    assert.equal(byHeadFile.get("a.js"), "a.js");
    assert.equal(byHeadFile.get("z.js"), "z.js");
  });
});

describe("continuity: diffLineIndices", () => {
  it("reports a rewritten line as removed and added, never as unchanged", () => {
    const diff = diffLineIndices(["a", "b", "c"], ["a", "B", "c"]);
    assert.deepEqual([...diff.addedHead].sort(), [1]);
    assert.deepEqual([...diff.removedBase].sort(), [1]);
  });

  it("honours a caller-supplied equality, which is what movement comparison needs", () => {
    // Indentation drift must not read as a change to the line's content.
    const eq = (a: string, b: string) => a.trim() === b.trim();
    const diff = diffLineIndices(["  a();"], ["a();"], eq);
    assert.equal(diff.addedHead.size, 0);
    assert.equal(diff.removedBase.size, 0);
  });
});
