import { test } from "node:test";
import assert from "node:assert/strict";
import { interpolate } from "../src/interpolate.js";
import { flagRule, lintWith, testRule } from "./fixtures.js";

test("interpolate substitutes {{ }} markers exactly like ESLint", () => {
  assert.equal(interpolate("a {{x}} b", { x: "X" }), "a X b");
  assert.equal(interpolate("a {{ x }} b", { x: "X" }), "a X b");
  assert.equal(interpolate("{{a}}{{b}}", { a: "1", b: "2" }), "12");
});

test("interpolate leaves missing placeholders and non-placeholders alone", () => {
  assert.equal(interpolate("{{missing}}", { other: 1 }), "{{missing}}");
  assert.equal(interpolate("no markers here", {}), "no markers here");
  assert.equal(interpolate("{{a}}", null), "{{a}}");
  assert.equal(interpolate("stray {{ braces }}", undefined), "stray {{ braces }}");
});

test("interpolate performs no %-style interpolation", () => {
  assert.equal(interpolate("50% off {{x}}", { x: "X" }), "50% off X");
  assert.equal(interpolate("100% of it", { x: "X" }), "100% of it");
});

test("interpolate coerces replacement values the way String#replace does", () => {
  const data = { a: 1, b: true, c: 2n, d: null, e: undefined };
  assert.equal(
    interpolate("{{a}}/{{b}}/{{c}}/{{d}}/{{e}}", data),
    "1/true/2/null/undefined",
  );
});

test("helpers.message throws a descriptive error for an unknown message id", () => {
  let thrown: unknown;
  const composed = testRule({
    tailors: flagRule,
    report(detection, helpers) {
      if (detection.messageId !== "flagged") return undefined;
      try {
        helpers.message("does-not-exist");
      } catch (error) {
        thrown = error;
      }
      return undefined;
    },
  });

  lintWith(composed, "flag;\n");
  assert.ok(thrown instanceof TypeError);
  assert.match((thrown as Error).message, /unknown messageId 'does-not-exist'/);
  assert.match((thrown as Error).message, /flagged/);
});
