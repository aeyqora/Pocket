import type { Rule } from "eslint";
import { composeRule } from "./compose.js";
import {
  TAILORING,
  type TailoredRuleModule,
  type TailoringDefinition,
  type UpstreamPlugin,
} from "./types.js";
import { assertTailoringDefinition } from "./validate.js";

/**
 * Wrap an upstream plugin so its tailored rules' reports are reshaped while the
 * upstream rules keep sole ownership of detection.
 *
 * Returns a new plugin object shaped exactly like `upstreamPlugin`: every rule
 * is carried over (un-tailored rules by object identity), each tailored rule
 * module resolves its upstream rule by name and is composed in place under the
 * same rule ID, and named configs are rewritten so any self-reference to the
 * upstream plugin points at the wrapper instead.
 *
 * Flat config compares plugin objects by reference and refuses to register two
 * different objects under one namespace (`Cannot redefine plugin`), so the wrap
 * must happen here, on the plugin object, before any config spreads it. Because
 * rule IDs and `meta.namespace` are unchanged, upstream configs then serve the
 * tailored rules automatically.
 *
 * @param upstreamPlugin the original plugin object (or a config-compatible bag).
 * @param tailoredRuleModules tailored rule modules built with
 *   `defineTailoredRule` whose `tailors` is the upstream rule's name. At most
 *   one module per rule.
 */
export function tailor<P extends UpstreamPlugin>(
  upstreamPlugin: P,
  tailoredRuleModules: readonly TailoredRuleModule[] = [],
): P {
  const upstreamRules: Record<string, Rule.RuleModule> = upstreamPlugin.rules ?? {};
  const pluginName = upstreamPlugin.meta?.name ?? "(unnamed plugin)";

  // Resolve and validate every tailored rule module before composing anything,
  // so a wiring mistake fails at load time with a message that names the module.
  const moduleIndexByRule = new Map<string, number>();

  tailoredRuleModules.forEach((module, index) => {
    const definition: TailoringDefinition | undefined = module?.[TAILORING];
    if (!definition) {
      throw new Error(
        `pocket-tailor: tailor() was given a value that is not a tailored rule module ` +
          `at index ${index}. Create tailored rule modules with defineTailoredRule().`,
      );
    }

    assertTailoringDefinition(definition);

    const target = definition.tailors;
    if (typeof target !== "string") {
      throw new Error(
        `pocket-tailor: ${describeModule(definition, index)} cannot be resolved: tailor() ` +
          `resolves upstream rules by name. Declare it as \`tailors: "rule-name"\` (the ` +
          `rule's id inside '${pluginName}') so tailor() can find and compose it.`,
      );
    }

    if (!Object.hasOwn(upstreamRules, target)) {
      throw new Error(
        `pocket-tailor: ${describeModule(definition, index)} names upstream rule ` +
          `'${target}', which plugin '${pluginName}' does not define. ` +
          `Known rules: ${listRuleNames(upstreamRules)}.`,
      );
    }

    const firstIndex = moduleIndexByRule.get(target);
    if (firstIndex !== undefined) {
      throw new Error(
        `pocket-tailor: upstream rule '${target}' is tailored by more than one module ` +
          `(index ${firstIndex} and index ${index}). Each upstream rule can be tailored ` +
          `by at most one module.`,
      );
    }
    moduleIndexByRule.set(target, index);
  });

  const rules: Record<string, Rule.RuleModule> = { ...upstreamRules };
  for (const [ruleName, index] of moduleIndexByRule) {
    const module = tailoredRuleModules[index]!;
    rules[ruleName] = composeRule(upstreamRules[ruleName]!, module[TAILORING]);
  }

  // `{ ...upstreamPlugin }` carries `meta` (including `namespace`), processors,
  // languages, and every other key verbatim; only `rules`/`configs` differ.
  const wrapped: UpstreamPlugin = { ...upstreamPlugin, rules };
  if (upstreamPlugin.configs) {
    wrapped.configs = remapConfigs(upstreamPlugin.configs, upstreamPlugin, wrapped);
  }

  return wrapped as P;
}

/** A human-readable pointer to the offending tailored rule module. */
function describeModule(definition: TailoringDefinition, index: number): string {
  const description = definition.meta.docs.description;
  const label = `"${description}"`;
  const target =
    typeof definition.tailors === "string" ? `'${definition.tailors}'` : "a rule module";
  return `module at index ${index} (${label}, tailors ${target})`;
}

/** Render the upstream plugin's rule names for a "did you mean" style error. */
function listRuleNames(rules: Record<string, unknown>): string {
  const names = Object.keys(rules);
  return names.length === 0 ? "(none)" : names.map((name) => `'${name}'`).join(", ");
}

/**
 * Rewrite every reference to the upstream plugin object in a plugin's configs
 * to the wrapped plugin, so a config that embeds `plugins: { ns: plugin }`
 * keeps working after the wrapper replaces it under the same namespace.
 *
 * Structural sharing: subtrees that hold no reference keep their identity, and
 * only the containers on the path to a match are cloned. The upstream plugin's
 * config objects are never mutated.
 */
function remapConfigs(
  configs: Record<string, unknown>,
  from: UpstreamPlugin,
  to: UpstreamPlugin,
): Record<string, unknown> {
  const remapped: Record<string, unknown> = {};
  for (const [key, config] of Object.entries(configs)) {
    remapped[key] = replacePluginReference(config, from, to);
  }
  return remapped;
}

function replacePluginReference(
  value: unknown,
  from: UpstreamPlugin,
  to: UpstreamPlugin,
): unknown {
  if (value === from) {
    return to;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const replaced = replacePluginReference(item, from, to);
      if (replaced !== item) {
        changed = true;
      }
      return replaced;
    });
    return changed ? next : value;
  }

  if (isPlainObject(value)) {
    let clone: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) {
      const replaced = replacePluginReference(item, from, to);
      if (replaced !== item) {
        clone ??= { ...value };
        defineOwn(clone, key, replaced);
      }
    }
    return clone ?? value;
  }

  // Functions, class instances (parsers, processors), and primitives are kept
  // by reference: cloning them would break identity-sensitive config members.
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Assign an own data property even for the `__proto__` key (never a setter). */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
