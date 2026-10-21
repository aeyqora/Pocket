import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rule } from "eslint";
import { composeRule, defineTailoredRule, TAILORING } from "../src/index.js";
import {
  defaultedRule,
  fixableRule,
  fixturePlugin,
  flagRule,
  legacyFixRule,
  lintWith,
  literalRule,
  locRule,
  multiArgRule,
  testDocs,
  testRule,
  twoIdsRule,
} from "./fixtures.js";

test("composed rule replaces the upstream message at the same location", () => {
  const rule = testRule({
    tailors: flagRule,
    meta: { messages: { customFlagged: "Do not use {{name}}: it is {{word}}" } },
    report(detection, helpers) {
      if (detection.messageId !== "flagged") return;
      return { message: helpers.message("customFlagged", detection.data) };
    },
  });

  const messages = lintWith(rule, "flag;\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.message, "Do not use flag: it is bad");
  assert.equal(messages[0]!.ruleId, "fixture/the-rule");
  assert.equal(messages[0]!.line, 1);
  assert.equal(messages[0]!.column, 1);
});

test("returning nothing forwards the upstream report byte for byte", () => {
  const cases: Array<[string, Rule.RuleModule, string]> = [
    ["messageId + data", flagRule, "flag;\n"],
    ["literal message", literalRule, "literal;\n"],
    ["legacy multi-arg form", multiArgRule, "legacy;\n"],
    ["legacy multi-arg form with a fix", legacyFixRule, "legacyfix;\n"],
    ["fixable report", fixableRule, "fixme;\n"],
    ["bare loc report", locRule, "anything;\n"],
  ];

  for (const [label, upstream, code] of cases) {
    const composed = testRule({ tailors: upstream, report: () => undefined });
    assert.deepEqual(lintWith(composed, code), lintWith(upstream, code), label);
  }
});

test("a missing hook and a null return both mean pass-through, never suppression", () => {
  const passthrough = defineTailoredRule({
    tailors: flagRule,
    meta: { docs: testDocs, messages: { unrelated: "never reported by upstream" } },
  });
  const nullHook = testRule({ tailors: flagRule, report: () => null });

  for (const composed of [passthrough, nullHook]) {
    const messages = lintWith(composed, "flag;\n");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.message, "upstream: flag is bad");
    assert.equal(messages[0]!.messageId, "flagged");
  }
});

test("a hook only reshapes the detections it claims; the rest pass through", () => {
  const composed = testRule({
    tailors: twoIdsRule,
    meta: { messages: { tailoredAlpha: "tailored {{name}}" } },
    report: (detection, helpers) =>
      detection.messageId === "alpha"
        ? { message: helpers.message("tailoredAlpha", detection.data) }
        : undefined,
  });

  const messages = lintWith(composed, "alpha; beta;\n");
  assert.deepEqual(
    messages.map((m) => m.message),
    ["tailored alpha", "beta: beta"],
  );
});

test("detection parity: the composed rule fires exactly where upstream fires", () => {
  const composed = testRule({ tailors: flagRule });
  const codes = [
    "flag;\n",
    "ok;\n",
    "flag; ok;\n",
    "function f(flag) { return flag; }\n",
    "const flag = 1; flag;\n",
    "flag;flag;\n",
  ];
  const where = (messages: ReturnType<typeof lintWith>) =>
    messages.map((m) => [m.line, m.column, m.endLine, m.endColumn, m.messageId]);

  for (const code of codes) {
    assert.deepEqual(where(lintWith(composed, code)), where(lintWith(flagRule, code)), code);
  }
});

test("upstream options are forwarded verbatim to upstream detection", () => {
  const composed = testRule({
    tailors: flagRule,
    meta: { messages: { custom: "{{name}} => {{word}}" } },
    report: (detection, helpers) =>
      detection.messageId === "flagged"
        ? { message: helpers.message("custom", detection.data) }
        : undefined,
  });

  const [message] = lintWith(composed, "flag;\n", { options: [{ severityWord: "terrible" }] });
  assert.equal(message!.message, "flag => terrible");
});

test("options configured for upstream reach the hook's detection and helpers", () => {
  let detectionOptions: readonly unknown[] | undefined;
  let helperOptions: readonly unknown[] | undefined;
  const composed = testRule({
    tailors: flagRule,
    report: (detection, helpers) => {
      detectionOptions = detection.options;
      helperOptions = helpers.options;
      return undefined;
    },
  });

  lintWith(composed, "flag;\n", { options: [{ severityWord: "x" }] });
  assert.deepEqual(detectionOptions, [{ severityWord: "x" }]);
  assert.deepEqual(helperOptions, [{ severityWord: "x" }]);
});

test("the composed schema is the upstream schema, so options validate identically", () => {
  const composed = testRule({ tailors: flagRule, meta: { messages: {} } });
  assert.equal(composed.meta!.schema, flagRule.meta!.schema);

  assert.doesNotThrow(() => lintWith(composed, "flag;\n", { options: [{ severityWord: "ok" }] }));
  assert.throws(() => lintWith(composed, "flag;\n", { options: [{ unknown: true }] }));
  assert.throws(() => lintWith(flagRule, "flag;\n", { options: [{ unknown: true }] }));
});

test("upstream defaultOptions are preserved and merged verbatim", () => {
  const composed = testRule({ tailors: defaultedRule });
  assert.equal(composed.meta!.defaultOptions, defaultedRule.meta!.defaultOptions);

  assert.equal(lintWith(composed, "defaulted;\n")[0]!.message, "defaulted: defaulted");
  assert.equal(
    lintWith(composed, "defaulted;\n", { options: [{ word: "override" }] })[0]!.message,
    "defaulted: override",
  );
});

test("the hook receives sourceCode, filename, options, and settings", () => {
  const seen: Record<string, unknown> = {};
  const composed = testRule({
    tailors: flagRule,
    report(detection, helpers) {
      seen.text = helpers.sourceCode.getText(detection.node);
      seen.filename = helpers.filename;
      seen.options = helpers.options;
      seen.settings = helpers.settings;
      return undefined;
    },
  });

  lintWith(composed, "flag;\n", { filename: "src/example.js", settings: { flavor: "pocket" } });

  assert.equal(seen.text, "flag");
  assert.equal(seen.filename, "src/example.js");
  assert.deepEqual(seen.options, []);
  assert.deepEqual(seen.settings, { flavor: "pocket" });
});

test("authored messages win id collisions; schema and defaultOptions stay upstream", () => {
  const composed = testRule({
    tailors: flagRule,
    meta: { messages: { flagged: "author override {{name}} {{word}}" } },
  });

  assert.equal(composed.meta!.messages!.flagged, "author override {{name}} {{word}}");
  assert.equal(composed.meta!.messages!.flagged !== flagRule.meta!.messages!.flagged, true);
  assert.equal(composed.meta!.schema, flagRule.meta!.schema);
  assert.equal(composed.meta!.defaultOptions, flagRule.meta!.defaultOptions);
  assert.equal(composed.meta!.type, "problem");
});

test("the hook may return a messageId resolved against authored meta", () => {
  const composed = testRule({
    tailors: flagRule,
    meta: { messages: { renamed: "renamed {{name}}" } },
    report: (detection) =>
      detection.messageId === "flagged" ? { messageId: "renamed", data: detection.data } : undefined,
  });

  const [message] = lintWith(composed, "flag;\n");
  assert.equal(message!.messageId, "renamed");
  assert.equal(message!.message, "renamed flag");
});

test("the hook may switch a literal upstream message to a messageId", () => {
  const composed = testRule({
    tailors: literalRule,
    meta: { messages: { custom: "custom literal" } },
    report: (detection) =>
      detection.message === "upstream literal" ? { messageId: "custom" } : undefined,
  });

  const [message] = lintWith(composed, "literal;\n");
  assert.equal(message!.messageId, "custom");
  assert.equal(message!.message, "custom literal");
});

test("a name-form declaration throws clearly until composed", () => {
  const declaration = testRule({
    tailors: "flag-identifier",
    meta: { messages: { tailored: "tailored {{name}}" } },
    report: (detection, helpers) =>
      detection.messageId === "flagged"
        ? { message: helpers.message("tailored", detection.data) }
        : undefined,
  });

  assert.equal(declaration[TAILORING].tailors, "flag-identifier");
  assert.equal(declaration.meta!.messages!.tailored, "tailored {{name}}");
  assert.throws(
    () => declaration.create({} as Rule.RuleContext),
    /has not been resolved/,
  );

  const upstream = fixturePlugin.rules["flag-identifier"]!;
  const composed = composeRule(upstream, declaration[TAILORING]);
  assert.equal(lintWith(composed, "flag;\n")[0]!.message, "tailored flag");
});

test("a direct-module composition is runnable and carries its definition", () => {
  const definition = {
    tailors: flagRule,
    meta: { docs: testDocs },
    report: () => undefined,
  } as const;
  const composed = testRule(definition);

  assert.equal(typeof composed.create, "function");
  assert.equal(composed[TAILORING].tailors, flagRule);
  assert.equal(
    composeRule(flagRule, definition)[TAILORING].tailors,
    flagRule,
  );
});

test("detection exposes the node the upstream rule reported", () => {
  let node: unknown;
  let loc: unknown = "unset";
  const composed = testRule({
    tailors: flagRule,
    report(detection) {
      node = detection.node;
      loc = detection.loc;
      return undefined;
    },
  });

  lintWith(composed, "flag;\n");
  assert.equal((node as { type: string }).type, "Identifier");
  assert.equal((node as { name: string }).name, "flag");
  assert.equal(loc, undefined);
});

test("detection exposes a bare loc the upstream rule reported", () => {
  let loc: unknown;
  let node: unknown;
  const composed = testRule({
    tailors: locRule,
    report(detection) {
      loc = detection.loc;
      node = detection.node;
      return undefined;
    },
  });

  lintWith(composed, "anything;\n");
  assert.deepEqual(loc, { line: 1, column: 0 });
  assert.equal(node, undefined);
});

test("a hook returning both loc and node keeps loc (ESLint prefers loc over node)", () => {
  const composed = testRule({
    tailors: flagRule,
    report: (detection) =>
      detection.messageId === "flagged"
        ? // The node points at `flag` (line 1, column 1); the loc points elsewhere.
          { node: detection.node, loc: { line: 1, column: 10 } }
        : undefined,
  });

  const [message] = lintWith(composed, "flag;\n");
  assert.equal(message!.line, 1);
  assert.equal(message!.column, 11);
});
