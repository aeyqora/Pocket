import { Linter, type Rule } from "eslint";
import type { UpstreamPlugin } from "../src/index.js";

/**
 * Build a synthetic upstream plugin that self-registers: `buildConfigs` is
 * called with the plugin object itself, so a named config can embed
 * `plugins: { ns: plugin }` exactly as a real plugin's recommended config does.
 * Nothing built here is a published plugin.
 */
export function selfRegisteringPlugin(
  meta: NonNullable<UpstreamPlugin["meta"]>,
  rules: Record<string, Rule.RuleModule>,
  buildConfigs: (plugin: UpstreamPlugin) => Record<string, unknown>,
): UpstreamPlugin {
  const plugin: UpstreamPlugin = { meta, rules };
  plugin.configs = buildConfigs(plugin);
  return plugin;
}

/** Options accepted by {@link flagRule}. */
export interface FlagOptions {
  severityWord?: string;
}

/**
 * Synthetic upstream rule: reports every `Identifier` named `flag` with a
 * `messageId` plus `data`, and varies that data with its configured options.
 * Detection is intentionally trivial; these fixtures exist to exercise the
 * composition engine, never a real published plugin.
 */
export const flagRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Synthetic upstream rule for pocket-tailor tests." },
    schema: [
      {
        type: "object",
        properties: { severityWord: { type: "string" } },
        additionalProperties: false,
      },
    ],
    messages: {
      flagged: "upstream: {{name}} is {{word}}",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as FlagOptions;
    const word = options.severityWord ?? "bad";
    return {
      Identifier(node) {
        if (node.name === "flag") {
          context.report({
            node,
            messageId: "flagged",
            data: { name: node.name, word },
          });
        }
      },
    };
  },
};

/** Synthetic upstream rule that reports a literal `message` (no `messageId`). */
export const literalRule: Rule.RuleModule = {
  meta: { type: "problem", schema: [], messages: {} },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === "literal") {
          context.report({ node, message: "upstream literal" });
        }
      },
    };
  },
};

/** Synthetic upstream rule that reports through the legacy multi-arg form. */
export const multiArgRule: Rule.RuleModule = {
  meta: { type: "problem", schema: [], messages: {} },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === "legacy") {
          context.report(node, "legacy {{name}}", { name: node.name });
        }
      },
    };
  },
};

/** Synthetic upstream rule with a fix, to prove pass-through preserves fixes. */
export const fixableRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    fixable: "code",
    schema: [],
    messages: { fixable: "upstream fixable {{name}}" },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === "fixme") {
          context.report({
            node,
            messageId: "fixable",
            data: { name: node.name },
            fix: (fixer) => fixer.replaceText(node, "fixed"),
          });
        }
      },
    };
  },
};

/** Synthetic upstream rule declaring a `whitespace` fix type. */
export const whitespaceFixRule: Rule.RuleModule = {
  meta: {
    type: "layout",
    fixable: "whitespace",
    schema: [],
    messages: { spaced: "upstream: {{name}} needs spacing" },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === "spaced") {
          context.report({
            node,
            messageId: "spaced",
            data: { name: node.name },
            fix: (fixer) => fixer.insertTextBefore(node, " "),
          });
        }
      },
    };
  },
};

/** Synthetic upstream rule that reports through the legacy form with a fix. */
export const legacyFixRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    fixable: "code",
    schema: [],
    messages: {},
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === "legacyfix") {
          context.report(node, "legacy fixme {{name}}", { name: node.name }, (fixer) =>
            fixer.replaceText(node, "legacyFixed"),
          );
        }
      },
    };
  },
};

/** Synthetic upstream rule reporting a bare `loc` instead of a node. */
export const locRule: Rule.RuleModule = {
  meta: { type: "problem", schema: [], messages: {} },
  create(context) {
    return {
      Program() {
        context.report({ loc: { line: 1, column: 0 }, message: "loc report" });
      },
    };
  },
};

/** Synthetic upstream rule reporting two distinct message ids. */
export const twoIdsRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: { alpha: "alpha: {{name}}", beta: "beta: {{name}}" },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === "alpha" || node.name === "beta") {
          context.report({ node, messageId: node.name, data: { name: node.name } });
        }
      },
    };
  },
};

/** Synthetic upstream rule carrying `meta.defaultOptions`. */
export const defaultedRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [
      {
        type: "object",
        properties: { word: { type: "string" } },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ word: "defaulted" }],
    messages: { found: "defaulted: {{word}}" },
  },
  create(context) {
    const word = (context.options[0] as { word?: string }).word;
    return {
      Identifier(node) {
        if (node.name === "defaulted") {
          context.report({ node, messageId: "found", data: { word } });
        }
      },
    };
  },
};

/** Synthetic plugin object wrapping the fixture rules. */
export const fixturePlugin = {
  meta: { name: "fixture", version: "1.0.0" },
  rules: {
    "flag-identifier": flagRule,
    "literal-message": literalRule,
    "legacy-message": multiArgRule,
    "fixable-identifier": fixableRule,
    "whitespace-fix-identifier": whitespaceFixRule,
    "legacy-fix-identifier": legacyFixRule,
    "loc-message": locRule,
    "two-ids": twoIdsRule,
    "defaulted-identifier": defaultedRule,
  },
};

export interface LintOptions {
  options?: unknown[];
  settings?: Record<string, unknown>;
  filename?: string;
}

/**
 * Lint `code` with `rule` registered under a stable synthetic id, so upstream
 * and composed runs can be compared message for message.
 */
function lintConfig(rule: Rule.RuleModule, options: unknown[], settings?: Record<string, unknown>) {
  return {
    plugins: { fixture: { rules: { "the-rule": rule } } },
    rules: { "fixture/the-rule": ["error", ...options] },
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    ...(settings ? { settings } : {}),
  };
}

export function lintWith(
  rule: Rule.RuleModule,
  code: string,
  { options = [], settings, filename }: LintOptions = {},
): Linter.LintMessage[] {
  const linter = new Linter();
  return linter.verify(code, lintConfig(rule, options, settings), filename);
}

/**
 * Model `eslint --fix` end to end: run `verify` and apply every `fix` in the
 * report (up to ESLint's pass limit), exactly as the CLI does. Suggestions are
 * never applied. The returned `output` is the would-be file contents.
 */
export function fixWith(
  rule: Rule.RuleModule,
  code: string,
  { options = [], settings, filename }: LintOptions = {},
): Linter.FixReport {
  const linter = new Linter();
  return linter.verifyAndFix(code, lintConfig(rule, options, settings), filename);
}
