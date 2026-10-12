import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleTester } from "eslint";
import { defineTailoredRule } from "../src/index.js";
import { fixWith, fixableRule, flagRule, lintWith, whitespaceFixRule } from "./fixtures.js";

// Ticket 03: injected fixes and suggestions (ADR-0003). By default an authored
// fix is an editor suggestion; `autofix: true` opts into `--fix`.

test("an authored fix on a non-fixable upstream rule becomes a suggestion", () => {
  const rule = defineTailoredRule({
    tailors: flagRule,
    report: (detection) =>
      detection.messageId === "flagged"
        ? { fix: (fixer) => fixer.replaceText(detection.node!, "fixed") }
        : undefined,
  });

  const [message] = lintWith(rule, "flag;\n");
  assert.equal(message!.fix, undefined);
  assert.equal(message!.suggestions!.length, 1);
  assert.deepEqual(message!.suggestions![0]!.fix, { range: [0, 4], text: "fixed" });
  assert.equal(message!.suggestions![0]!.desc, "Apply the tailored fix.");
});

test("meta.hasSuggestions is synthesized for an opinionated fix; meta.fixable stays unset", () => {
  const composed = defineTailoredRule({ tailors: flagRule });

  assert.equal(composed.meta!.fixable, undefined);
  assert.equal(composed.meta!.hasSuggestions, true);
});

test("an upstream meta.hasSuggestions is preserved on the composed rule", () => {
  const upstream = {
    meta: { type: "problem", hasSuggestions: true, schema: [] as never[], messages: {} },
    create: () => ({}),
  };
  const composed = defineTailoredRule({ tailors: upstream, autofix: true });

  assert.equal(composed.meta!.hasSuggestions, true);
  assert.equal(composed.meta!.fixable, "code");
});

test("--fix does not apply a suggested fix by default", () => {
  const rule = defineTailoredRule({
    tailors: flagRule,
    report: (detection) =>
      detection.messageId === "flagged"
        ? { fix: (fixer) => fixer.replaceText(detection.node!, "fixed") }
        : undefined,
  });

  const report = fixWith(rule, "flag;\n");
  assert.equal(report.fixed, false);
  assert.equal(report.output, "flag;\n");
});

test("autofix: true makes --fix apply the authored fix and marks the rule fixable", () => {
  const rule = defineTailoredRule({
    tailors: flagRule,
    autofix: true,
    report: (detection) =>
      detection.messageId === "flagged"
        ? { fix: (fixer) => fixer.replaceText(detection.node!, "fixed") }
        : undefined,
  });

  assert.equal(rule.meta!.fixable, "code");
  assert.equal(rule.meta!.hasSuggestions, undefined);

  const [message] = lintWith(rule, "flag;\n");
  assert.deepEqual(message!.fix, { range: [0, 4], text: "fixed" });
  assert.equal(message!.suggestions, undefined);

  const report = fixWith(rule, "flag;\n");
  assert.equal(report.fixed, true);
  assert.equal(report.output, "fixed;\n");
});

test("a hook that only rewrites the message keeps the upstream fix as an autofix", () => {
  const rule = defineTailoredRule({
    tailors: fixableRule,
    report: (detection) =>
      detection.messageId === "fixable" ? { message: "tailored message" } : undefined,
  });

  const [message] = lintWith(rule, "fixme;\n");
  assert.equal(message!.message, "tailored message");
  assert.deepEqual(message!.fix, { range: [0, 5], text: "fixed" });
  assert.equal(message!.suggestions, undefined);

  assert.equal(fixWith(rule, "fixme;\n").output, "fixed;\n");
});

test("upstream meta.fixable is preserved, and autofix reuses its type", () => {
  const preserved = defineTailoredRule({ tailors: whitespaceFixRule });
  assert.equal(preserved.meta!.fixable, "whitespace");

  const authored = defineTailoredRule({
    tailors: whitespaceFixRule,
    autofix: true,
    report: (detection) =>
      detection.messageId === "spaced"
        ? { fix: (fixer) => fixer.insertTextBefore(detection.node!, "\t") }
        : undefined,
  });
  assert.equal(authored.meta!.fixable, "whitespace");
});

test("an authored fix overrides an upstream fix and becomes a suggestion by default", () => {
  const rule = defineTailoredRule({
    tailors: fixableRule,
    report: (detection) =>
      detection.messageId === "fixable"
        ? { fix: (fixer) => fixer.replaceText(detection.node!, "tailored") }
        : undefined,
  });

  const [message] = lintWith(rule, "fixme;\n");
  assert.equal(message!.fix, undefined);
  assert.equal(message!.suggestions!.length, 1);
  assert.deepEqual(message!.suggestions![0]!.fix, { range: [0, 5], text: "tailored" });

  // The authored fix pre-empts upstream's own fix, so --fix leaves the file alone.
  assert.equal(fixWith(rule, "fixme;\n").output, "fixme;\n");
});

test("a hook may return suggestions directly, and an authored fix is appended", () => {
  const rule = defineTailoredRule({
    tailors: flagRule,
    meta: { messages: { constHint: "declare with const" } },
    report: (detection) =>
      detection.messageId === "flagged"
        ? {
            fix: (fixer) => fixer.replaceText(detection.node!, "let flag"),
            suggest: [
              {
                messageId: "constHint",
                fix: (fixer) => fixer.replaceText(detection.node!, "const flag"),
              },
            ],
          }
        : undefined,
  });

  const [message] = lintWith(rule, "flag;\n");
  assert.equal(message!.suggestions!.length, 2);
  assert.equal(message!.suggestions![0]!.messageId, "constHint");
  assert.deepEqual(message!.suggestions![0]!.fix, { range: [0, 4], text: "const flag" });
  assert.equal(message!.suggestions![1]!.desc, "Apply the tailored fix.");
  assert.deepEqual(message!.suggestions![1]!.fix, { range: [0, 4], text: "let flag" });
});

test("a converted fix takes an authored suggestion messageId and data", () => {
  const rule = defineTailoredRule({
    tailors: flagRule,
    meta: { messages: { useImage: "replace {{name}} with <Image>" } },
    report: (detection) =>
      detection.messageId === "flagged"
        ? {
            fix: (fixer) => fixer.replaceText(detection.node!, "<Image />"),
            suggestionMessageId: "useImage",
            suggestionData: detection.data,
          }
        : undefined,
  });

  const [message] = lintWith(rule, "flag;\n");
  const [suggestion] = message!.suggestions!;
  assert.equal(suggestion!.messageId, "useImage");
  assert.equal(suggestion!.desc, "replace flag with <Image>");
});

test("a converted fix takes an authored suggestionDesc when provided", () => {
  const rule = defineTailoredRule({
    tailors: flagRule,
    report: (detection) =>
      detection.messageId === "flagged"
        ? {
            fix: (fixer) => fixer.replaceText(detection.node!, "<Image />"),
            suggestionDesc: "Swap in <Image />.",
          }
        : undefined,
  });

  const [message] = lintWith(rule, "flag;\n");
  assert.equal(message!.suggestions![0]!.desc, "Swap in <Image />.");
});

test("a suggestion applies to the exact fixture range and --fix leaves it alone (RuleTester)", () => {
  const rule = defineTailoredRule({
    tailors: flagRule,
    report: (detection) =>
      detection.messageId === "flagged"
        ? { fix: (fixer) => fixer.replaceText(detection.node!, "fixed") }
        : undefined,
  });

  const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
  });
  ruleTester.run("injected-suggestion", rule, {
    valid: [{ code: "const ok = 1;\n" }],
    invalid: [
      {
        code: "flag;\n",
        output: null,
        errors: [
          {
            messageId: "flagged",
            suggestions: [{ desc: "Apply the tailored fix.", output: "fixed;\n" }],
          },
        ],
      },
    ],
  });
});

test("overlapping authored fixes fail loudly rather than corrupting output", () => {
  const rule = defineTailoredRule({
    tailors: flagRule,
    autofix: true,
    report: (detection) =>
      detection.messageId === "flagged"
        ? {
            fix: (fixer) => [
              fixer.replaceTextRange([0, 3], "aaa"),
              fixer.replaceTextRange([2, 4], "bb"),
            ],
          }
        : undefined,
  });

  assert.throws(() => lintWith(rule, "flag;\n"), /must not be overlapped/);
  assert.throws(() => fixWith(rule, "flag;\n"), /must not be overlapped/);
});

test("a malformed fix range fails loudly rather than corrupting output", () => {
  const rule = defineTailoredRule({
    tailors: flagRule,
    autofix: true,
    report: (detection) =>
      detection.messageId === "flagged"
        ? { fix: () => ({ range: null, text: "x" }) as never }
        : undefined,
  });

  assert.throws(() => lintWith(rule, "flag;\n"), /Fix has invalid range/);
});

// What ESLint catches, and what it does not (observed on eslint 10.12.0):
// - Overlapping fixes in one report throw `Fix objects must not be overlapped
//   in a report.` from `mergeFixes` at verify time (asserted above).
// - A fix whose `range` is not two numbers throws `Fix has invalid range: ...`
//   from `assertValidFix` at verify time (asserted above).
// - A numeric but out-of-bounds range is NOT validated: `SourceCodeFixer`
//   clamps it, e.g. `replaceTextRange([0, 9999], "X")` on `"flag;\n"` yields
//   `"X"`. pocket-tailor deliberately does not re-validate ranges — it relies
//   on ESLint's checks and forwards the authored fixer verbatim — so staying in
//   range remains the author's responsibility.
