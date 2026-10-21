import { test } from "node:test";
import assert from "node:assert/strict";
import { fixWith, flagRule, lintWith, literalRule, testRule, twoIdsRule } from "./fixtures.js";

test("a basic message overrides an id-based upstream message and interpolates its data", () => {
  const rule = testRule({
    tailors: flagRule,
    message: "Do not use <{{name}}>.",
  });

  const [message] = lintWith(rule, "flag;\n");
  assert.equal(message!.message, "Do not use <flag>.");
  assert.equal(message!.messageId, undefined);
});

test("a basic message overrides a plain upstream message", () => {
  const rule = testRule({
    tailors: literalRule,
    message: "Use the shared component instead.",
  });

  const [message] = lintWith(rule, "literal;\n");
  assert.equal(message!.message, "Use the shared component instead.");
});

test("a basic message overrides every message id upstream emits", () => {
  const rule = testRule({
    tailors: twoIdsRule,
    message: "This interaction needs a native control.",
  });

  const messages = lintWith(rule, "alpha; beta;\n");
  assert.deepEqual(
    messages.map((m) => m.message),
    ["This interaction needs a native control.", "This interaction needs a native control."],
  );
});

test("a fix-only hook keeps the basic message and applies the fix", () => {
  const rule = testRule({
    tailors: flagRule,
    message: "Do not use <{{name}}>.",
    autofix: true,
    report: (detection) =>
      detection.messageId === "flagged"
        ? { fix: (fixer) => fixer.replaceText(detection.node!, "fixed") }
        : undefined,
  });

  const [message] = lintWith(rule, "flag;\n");
  assert.equal(message!.message, "Do not use <flag>.");
  assert.deepEqual(message!.fix, { range: [0, 4], text: "fixed" });
  assert.equal(fixWith(rule, "flag;\n").output, "fixed;\n");
});

test("a hook messageId overrides the basic message", () => {
  const rule = testRule({
    tailors: flagRule,
    message: "Basic message.",
    meta: { messages: { renamed: "Renamed {{name}}." } },
    report: (detection) =>
      detection.messageId === "flagged"
        ? { messageId: "renamed", data: detection.data }
        : undefined,
  });

  const [message] = lintWith(rule, "flag;\n");
  assert.equal(message!.messageId, "renamed");
  assert.equal(message!.message, "Renamed flag.");
});

test("a hook message overrides the basic message", () => {
  const rule = testRule({
    tailors: flagRule,
    message: "Basic message.",
    report: (detection) =>
      detection.messageId === "flagged" ? { message: "Hook message." } : undefined,
  });

  const [message] = lintWith(rule, "flag;\n");
  assert.equal(message!.message, "Hook message.");
});

test("a hook that only changes data re-interpolates the basic message", () => {
  const rule = testRule({
    tailors: flagRule,
    message: "Do not use <{{name}}>.",
    report: (detection) =>
      detection.messageId === "flagged"
        ? { data: { ...detection.data, name: "gadget" } }
        : undefined,
  });

  const [message] = lintWith(rule, "flag;\n");
  assert.equal(message!.message, "Do not use <gadget>.");
});
