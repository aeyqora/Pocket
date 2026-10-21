import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rule } from "eslint";
import { composeRule, defineTailoredRule, TAILORING, tailor } from "../src/index.js";
import { flagRule, testDocs } from "./fixtures.js";

const messages = { flagged: "tailored {{name}}" };

test("a valid definition is accepted and keeps its docs", () => {
  const composed = composeRule(flagRule, {
    tailors: flagRule,
    meta: { docs: testDocs, messages },
  });

  assert.deepEqual(composed.meta!.docs, testDocs);
  assert.equal(composed.meta!.messages!.flagged, "tailored {{name}}");
});

test("meta is required", () => {
  assert.throws(
    () => defineTailoredRule({ tailors: "no-widget" } as never),
    /must declare meta/,
  );
});

test("meta.docs is required", () => {
  assert.throws(
    () => defineTailoredRule({ tailors: "no-widget", meta: { messages } }),
    /must declare meta\.docs/,
  );
});

test("meta.docs.description must be non-empty", () => {
  for (const description of ["", "   "]) {
    assert.throws(
      () =>
        defineTailoredRule({
          tailors: "no-widget",
          meta: { docs: { ...testDocs, description }, messages },
        }),
      /non-empty meta\.docs\.description/,
    );
  }
});

test("meta.docs.url must be an absolute http(s) URL", () => {
  for (const url of [undefined, "", "docs/no-widget", "/docs/no-widget", "ftp://example.test/docs"]) {
    assert.throws(
      () =>
        defineTailoredRule({
          tailors: "no-widget",
          meta: { docs: { ...testDocs, url: url as string }, messages },
        }),
      /absolute http\(s\) meta\.docs\.url/,
      String(url),
    );
  }
});

test("a tailored rule must declare messages or a report hook", () => {
  assert.throws(
    () => defineTailoredRule({ tailors: "no-widget", meta: { docs: testDocs } }),
    /must tailor presentation/,
  );

  assert.throws(
    () =>
      defineTailoredRule({
        tailors: "no-widget",
        meta: { docs: testDocs, messages: {} },
      }),
    /must tailor presentation/,
  );
});

test("a report hook alone satisfies the presentation requirement", () => {
  const declaration = defineTailoredRule({
    tailors: "no-widget",
    meta: { docs: testDocs },
    report: () => undefined,
  });

  assert.equal(declaration[TAILORING].tailors, "no-widget");
});

test("a basic message alone satisfies the presentation requirement", () => {
  const declaration = defineTailoredRule({
    tailors: "no-widget",
    message: "Use the shared component.",
    meta: { docs: testDocs },
  });

  assert.equal(declaration[TAILORING].message, "Use the shared component.");
});

test("a basic message must not be blank", () => {
  for (const message of ["", "   "]) {
    assert.throws(
      () =>
        defineTailoredRule({
          tailors: "no-widget",
          message,
          meta: { docs: testDocs },
        }),
      /non-empty message/,
    );
  }
});

test("declared messages must have non-empty text", () => {
  assert.throws(
    () =>
      defineTailoredRule({
        tailors: "no-widget",
        meta: { docs: testDocs, messages: { flagged: "  " } },
      }),
    /empty message for "flagged"/,
  );
});

test("report must be a function when present", () => {
  assert.throws(
    () =>
      defineTailoredRule({
        tailors: "no-widget",
        meta: { docs: testDocs },
        report: "nope" as never,
      }),
    /report as a function/,
  );
});

test("composeRule() applies the same guard for direct-module rules", () => {
  assert.throws(
    () => composeRule(flagRule, { tailors: flagRule, meta: { messages } } as never),
    /must declare meta\.docs/,
  );
});

test("tailor() rejects a hand-built module that skipped defineTailoredRule", () => {
  const upstream = {
    meta: { name: "fixture-plugin" },
    rules: { "flag-identifier": flagRule },
  };
  const handBuilt = {
    meta: { messages: { flagged: "tailored" } },
    create: () => ({}),
    [TAILORING]: {
      tailors: "flag-identifier",
      meta: { messages: { flagged: "tailored" } },
    },
  } as unknown as Rule.RuleModule;

  assert.throws(
    () => tailor(upstream, [handBuilt as never]),
    /must declare meta\.docs/,
  );
});
