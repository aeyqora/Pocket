import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Linter, RuleTester, type Rule } from "eslint";
import { defineConfig } from "eslint/config";
import * as api from "../src/index.js";
import {
  composeRule,
  defineTailoredRule,
  tailor,
  TAILORING,
  type UpstreamPlugin,
} from "../src/index.js";

// A guard for the README. Ticket 04 is a docs ticket, so the drift test lives
// with the docs: every public name and every quickstart/worked-example shape the
// README shows is reproduced here, end to end, against synthetic fixtures. No
// real published plugin is imported anywhere in this file — `eslint-plugin-thing`
// is a hypothetical plugin defined below.

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(packageRoot, "README.md"), "utf8");

// --- The hypothetical upstream plugin: eslint-plugin-thing ------------------

/** Upstream `no-widget`: flags identifiers named `widget`, plus `options.also`. */
const noWidgetRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Synthetic upstream rule for the pocket-tailor docs example." },
    schema: [
      {
        type: "object",
        properties: { also: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: { noWidget: "upstream: do not use <{{name}}>" },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as { also?: string[] };
    const flagged = new Set(["widget", ...(options.also ?? [])]);
    return {
      Identifier(node) {
        if (flagged.has(node.name)) {
          context.report({ node, messageId: "noWidget", data: { name: node.name } });
        }
      },
    };
  },
};

/** Upstream `prefer-panel`: flags identifiers named `card`. No options. */
const preferPanelRule: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: { usePanel: "upstream: prefer <Panel> over <{{name}}>" },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === "card") {
          context.report({ node, messageId: "usePanel", data: { name: node.name } });
        }
      },
    };
  },
};

/** Upstream `no-legacy`: carried over untouched, to prove pass-through by identity. */
const noLegacyRule: Rule.RuleModule = {
  meta: { type: "problem", schema: [], messages: { noLegacy: "upstream: no legacy" } },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === "legacy") {
          context.report({ node, messageId: "noLegacy" });
        }
      },
    };
  },
};

/**
 * Build the plugin the README names: a self-registering `flat/recommended`
 * config embedding the plugin object itself, exactly like a real plugin.
 */
function makeThing(): UpstreamPlugin {
  const plugin: UpstreamPlugin = {
    meta: { name: "eslint-plugin-thing", version: "1.0.0", namespace: "thing" },
    rules: {
      "no-widget": noWidgetRule,
      "prefer-panel": preferPanelRule,
      "no-legacy": noLegacyRule,
    },
  };
  plugin.configs = {
    "flat/recommended": [
      {
        plugins: { thing: plugin },
        rules: { "thing/no-widget": "error", "thing/prefer-panel": "error" },
      },
    ],
  };
  return plugin;
}

// --- The two tailored rule modules the README shows -------------------------

/** README quickstart / worked example (a): a repo-local tailored file. */
const repoLocalNoWidget = defineTailoredRule({
  tailors: "no-widget",
  meta: {
    messages: {
      noWidget:
        "Do not use <{{name}}>. Prefer the <Panel> component — it handles "
        + "labelling for you. Guide: https://example.dev/components/panel",
    },
  },
  report(detection) {
    if (detection.messageId !== "noWidget") return null;
    // A fix and nothing else: message, data, and location stay inherited from
    // upstream, and the fix becomes an editor suggestion (no `autofix: true`).
    return { fix: (fixer) => fixer.replaceText(detection.node!, "Panel") };
  },
});

/** README worked example (b): a module exported by a package the repo depends on. */
const sharedPreferPanel = defineTailoredRule({
  tailors: "prefer-panel",
  meta: {
    messages: {
      usePanel:
        "Use <Panel> instead of <{{name}}>. Panel guidance: "
        + "https://example.dev/components/panel",
    },
  },
});

/** Lint `code` through the plugin's recommended config, spread as the README does. */
function lint(wrapped: UpstreamPlugin, code: string, config: Linter.Config = {}): Linter.LintMessage[] {
  const flattened = defineConfig([
    ...(wrapped.configs!["flat/recommended"] as Linter.Config[]),
    { languageOptions: { ecmaVersion: 2022, sourceType: "module" }, ...config },
  ]);
  return new Linter().verify(code, flattened);
}

// --- (a) README documents the real public surface ---------------------------

test("the README documents every public runtime export under its real name", () => {
  const names = ["defineTailoredRule", "composeRule", "tailor", "TAILORING"];
  for (const name of names) {
    assert.ok(name in api, `${name} is exported`);
    assert.match(readme, new RegExp(`\\b${name}\\b`), `README documents ${name}`);
  }
});

test("the README keeps the required section headings", () => {
  for (const heading of [
    "# Pocket Tailor",
    "## Install",
    "## Quickstart",
    "## Worked adoption example",
    "## Migration guide",
    "## Testing tailored rules",
    "## Boundaries",
    "## Requirements",
    "## Development",
  ]) {
    assert.match(readme, new RegExp(`^${heading}$`, "m"), `README has ${heading}`);
  }
});

test("the README states the required runtime versions", () => {
  assert.match(readme, /20\.12/);
  assert.match(readme, /9\.34/);
});

test("the README uses only the generic eslint-plugin-thing example", () => {
  // The docs must never reference a real published plugin.
  assert.doesNotMatch(readme, /jsx-a11y/);
  assert.doesNotMatch(readme, /eslint-plugin-(?!thing)\w+/);
  assert.match(readme, /eslint-plugin-thing/);
});

// --- (b) Quickstart behavior -------------------------------------------------

test("quickstart: tailor() wraps the plugin and the recommended config serves the tailored rule", () => {
  const thing = makeThing();
  const tailoredThing = tailor(thing, [repoLocalNoWidget]);

  const [message] = lint(tailoredThing, "const widget = 1;\n");
  assert.equal(message!.ruleId, "thing/no-widget"); // rule id unchanged (ADR-0001)
  assert.equal(message!.messageId, "noWidget"); // upstream message id preserved
  assert.match(message!.message, /Do not use <widget>\. Prefer the <Panel> component/);
  assert.match(message!.message, /https:\/\/example\.dev\/components\/panel/);

  // The authored fix is an editor suggestion, not a --fix autofix.
  assert.equal(message!.fix, undefined);
  assert.equal(message!.suggestions!.length, 1);
  assert.deepEqual(message!.suggestions![0]!.fix, { range: [6, 12], text: "Panel" });
});

test("quickstart: upstream options reach upstream detection verbatim", () => {
  const tailoredThing = tailor(makeThing(), [repoLocalNoWidget]);

  // `gadget` is only flagged once the upstream rule is configured to flag it;
  // tailoring never changes what the upstream option does.
  assert.equal(lint(tailoredThing, "const gadget = 1;\n").length, 0);

  const extended = lint(tailoredThing, "const gadget = 1;\n", {
    rules: { "thing/no-widget": ["error", { also: ["gadget"] }] },
  });
  assert.equal(extended.length, 1);
  assert.match(extended[0]!.message, /Do not use <gadget>\./);
});

// --- (b) Worked adoption example: both placements, mixed in one call ---------

test("worked example: repo-local and shared-package rules mix in one tailor() call", () => {
  const thing = makeThing();
  const tailoredThing = tailor(thing, [repoLocalNoWidget, sharedPreferPanel]);

  const messages = lint(tailoredThing, "const widget = 1;\nconst card = 2;\n");

  const widget = messages.find((m) => m.ruleId === "thing/no-widget");
  assert.match(widget!.message, /Do not use <widget>/);

  const card = messages.find((m) => m.ruleId === "thing/prefer-panel");
  assert.equal(card!.messageId, "usePanel");
  assert.equal(card!.message, "Use <Panel> instead of <card>. Panel guidance: https://example.dev/components/panel");

  // Rules nobody tailors are carried over by object identity.
  assert.equal(tailoredThing.rules!["no-legacy"], thing.rules!["no-legacy"]);
});

// --- (b) Migration guide -----------------------------------------------------

test("migration: adopting swaps the plugin object; rule ids and disable comments stay valid", () => {
  const thing = makeThing();
  const tailoredThing = tailor(thing, [repoLocalNoWidget]);

  // Before adoption: upstream message.
  const upstream = new Linter().verify("const widget = 1;\n", [
    {
      plugins: { thing },
      rules: { "thing/no-widget": "error" },
      languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
  ]);
  assert.equal(upstream[0]!.ruleId, "thing/no-widget");
  assert.equal(upstream[0]!.message, "upstream: do not use <widget>");

  // After adoption: same rule id, tailored message.
  const adopted = lint(tailoredThing, "const widget = 1;\n");
  assert.equal(adopted[0]!.ruleId, "thing/no-widget");
  assert.match(adopted[0]!.message, /Prefer the <Panel> component/);

  // An `eslint-disable` comment written against the upstream id is still valid.
  const disabled = lint(tailoredThing, "/* eslint-disable thing/no-widget */\nconst widget = 1;\n");
  assert.equal(disabled.length, 0);
});

test("migration: reverting one rule means dropping its module; the upstream rule falls back", () => {
  const thing = makeThing();
  const reverted = tailor(thing, [repoLocalNoWidget]); // sharedPreferPanel removed

  assert.equal(reverted.rules!["prefer-panel"], thing.rules!["prefer-panel"]);

  const [message] = lint(reverted, "const card = 1;\n");
  assert.equal(message!.ruleId, "thing/prefer-panel");
  assert.equal(message!.message, "upstream: prefer <Panel> over <card>");
});

test("migration: enforcement is ordinary severity and path config", () => {
  const thing = makeThing();
  const tailoredThing = tailor(thing, [repoLocalNoWidget]);

  const warn = lint(tailoredThing, "const widget = 1;\n", {
    rules: { "thing/no-widget": "warn" },
  });
  assert.equal(warn[0]!.severity, 1);

  const off = lint(tailoredThing, "const widget = 1;\n", {
    rules: { "thing/no-widget": "off" },
  });
  assert.equal(off.length, 0);
});

// --- (b) Drift-test guidance: the documented mechanism -----------------------

test("drift: a name-form rule is a declaration until composed", () => {
  assert.equal(repoLocalNoWidget[TAILORING].tailors, "no-widget");
  assert.throws(
    () => repoLocalNoWidget.create({} as Rule.RuleContext),
    /has not been resolved/,
  );
});

test("drift: composeRule(upstream, tailored[TAILORING]) yields a RuleTester rule asserting the upstream id", () => {
  const rule = composeRule(noWidgetRule, repoLocalNoWidget[TAILORING]);

  new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
  }).run("thing/no-widget (composed)", rule, {
    valid: [{ code: "const ok = 1;\n" }],
    invalid: [
      {
        code: "const widget = 1;\n",
        output: null, // the authored fix is a suggestion; --fix leaves the file alone
        errors: [
          {
            messageId: "noWidget", // upstream still detects under this id
            suggestions: [{ desc: "Apply the tailored fix.", output: "const Panel = 1;\n" }],
          },
        ],
      },
    ],
  });
});

test("drift: the direct-module form is runnable under RuleTester with no harness", () => {
  const rule = defineTailoredRule({
    tailors: noWidgetRule,
    meta: { messages: { noWidget: "Tailored: no <widget>." } },
  });

  new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
  }).run("thing/no-widget (direct module)", rule, {
    valid: [{ code: "const ok = 1;\n" }],
    invalid: [{ code: "const widget = 1;\n", errors: [{ messageId: "noWidget" }] }],
  });
});

// --- The README's documented snippets appear where the docs claim them ------

test("the README shows the shapes this file exercises", () => {
  for (const anchor of [
    'tailors: "no-widget"',
    "tailor(thing, [noWidget, preferPanel])",
    'composeRule(thing.rules["no-widget"], tailored[TAILORING])',
    "eslint-plugin-thing",
    "is a declaration",
  ]) {
    assert.ok(readme.includes(anchor), `README includes ${JSON.stringify(anchor)}`);
  }
});
