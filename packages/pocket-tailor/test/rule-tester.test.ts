import { test } from "node:test";
import { RuleTester } from "eslint";
import { flagRule, testRule } from "./fixtures.js";

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

// The spec's test process: a composed rule is a rule-shaped module, so it runs
// in the standard RuleTester with no harness.
test("a composed rule runs under RuleTester with no harness", () => {
  const rule = testRule({
    tailors: flagRule,
    meta: { messages: { renamed: "renamed {{name}}" } },
    report: (detection) =>
      detection.messageId === "flagged"
        ? { messageId: "renamed", data: detection.data }
        : undefined,
  });

  ruleTester.run("flag-identifier", rule, {
    valid: [{ code: "const ok = 1;\n" }],
    invalid: [
      {
        code: "flag;\n",
        errors: [{ messageId: "renamed", data: { name: "flag" } }],
      },
    ],
  });
});

test("a composed rule asserting the upstream message id when it passes through", () => {
  const rule = testRule({ tailors: flagRule });

  ruleTester.run("flag-identifier-passthrough", rule, {
    valid: [{ code: "const ok = 1;\n" }],
    invalid: [
      {
        code: "flag;\n",
        errors: [{ messageId: "flagged", data: { name: "flag", word: "bad" } }],
      },
    ],
  });
});
