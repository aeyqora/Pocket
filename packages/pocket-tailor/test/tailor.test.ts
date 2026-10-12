import { test } from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import { defineConfig } from "eslint/config";
import { defineTailoredRule, tailor, TAILORING } from "../src/index.js";
import type { UpstreamPlugin } from "../src/index.js";
import { fixableRule, flagRule, literalRule, lintWith } from "./fixtures.js";

/**
 * A synthetic upstream plugin that carries a named config embedding the plugin
 * object itself, exactly as a real plugin's recommended config does. Nothing
 * here is a published plugin; the fixtures exist only to exercise `tailor()`.
 */
function makeUpstream(): UpstreamPlugin {
  const upstream: UpstreamPlugin = {
    meta: { name: "fixture-plugin", version: "1.0.0", namespace: "fixture" },
    rules: {
      "flag-identifier": flagRule,
      "literal-message": literalRule,
      "fixable-identifier": fixableRule,
    },
    configs: {},
  };

  // An array config whose rules are namespaced under the plugin's own namespace,
  // and which registers the plugin object itself (the "Cannot redefine plugin"
  // trap ADR-0002 avoids).
  upstream.configs!["flat/recommended"] = [
    {
      plugins: { fixture: upstream },
      rules: {
        "fixture/flag-identifier": "error",
        "fixture/literal-message": "error",
      },
    },
  ];

  // The same shape as a single (non-array) config object.
  upstream.configs!["flat/all"] = {
    plugins: { fixture: upstream },
    rules: { "fixture/fixable-identifier": "error" },
  };

  return upstream;
}

/** A tailoring module that targets the synthetic `flag-identifier` rule by name. */
const flagTailoring = defineTailoredRule({
  tailors: "flag-identifier",
  meta: { messages: { custom: "Tailored: do not use {{name}} ({{word}})" } },
  report: (detection, helpers) =>
    detection.messageId === "flagged"
      ? { message: helpers.message("custom", detection.data) }
      : undefined,
});

test("tailor() swaps the composed rule in under the upstream id; the rest pass through by identity", () => {
  const upstream = makeUpstream();
  const wrapped = tailor(upstream, [flagTailoring]);

  assert.notEqual(wrapped, upstream);

  const tailored = wrapped.rules!["flag-identifier"]!;
  assert.notEqual(tailored, upstream.rules!["flag-identifier"]);
  assert.equal(tailored[TAILORING], flagTailoring[TAILORING]);

  // Un-tailored rules keep their original object identity.
  assert.equal(wrapped.rules!["literal-message"], upstream.rules!["literal-message"]);
  assert.equal(wrapped.rules!["fixable-identifier"], upstream.rules!["fixable-identifier"]);

  // Each rule keeps the exact upstream key.
  assert.deepEqual(Object.keys(wrapped.rules!).sort(), Object.keys(upstream.rules!).sort());
});

test("the swapped rule composes the tailoring with unchanged upstream detection", () => {
  const wrapped = tailor(makeUpstream(), [flagTailoring]);

  const messages = lintWith(wrapped.rules!["flag-identifier"]!, "flag;\n");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.message, "Tailored: do not use flag (bad)");
  assert.equal(wrapped.rules!["flag-identifier"]!.meta!.schema, flagRule.meta!.schema);
});

test("the wrapped plugin preserves upstream meta (name, version, namespace)", () => {
  const upstream = makeUpstream();
  const wrapped = tailor(upstream, [flagTailoring]);

  assert.deepEqual(wrapped.meta, {
    name: "fixture-plugin",
    version: "1.0.0",
    namespace: "fixture",
  });
  assert.equal(wrapped.meta!.namespace, upstream.meta!.namespace);
});

test("named configs stay spreadable and resolve the tailored rule under the upstream id", () => {
  const upstream = makeUpstream();
  const wrapped = tailor(upstream, [flagTailoring]);

  const linter = new Linter();
  const messages = linter.verify("flag;\nliteral;\n", [
    ...(wrapped.configs!["flat/recommended"] as Linter.Config[]),
    { languageOptions: { ecmaVersion: 2022, sourceType: "module" } },
  ]);

  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.ruleId, "fixture/flag-identifier");
  assert.equal(messages[0]!.message, "Tailored: do not use flag (bad)");
  assert.equal(messages[1]!.ruleId, "fixture/literal-message");
  assert.equal(messages[1]!.message, "upstream literal");
});

test("configs that embed the upstream plugin are rewritten to the wrapped object, without mutating upstream", () => {
  const upstream = makeUpstream();
  const wrapped = tailor(upstream, [flagTailoring]);

  const recommended = (wrapped.configs!["flat/recommended"] as Linter.Config[])[0]!;
  assert.equal(recommended.plugins!["fixture"], wrapped);
  assert.notEqual(recommended.plugins!["fixture"], upstream);

  const all = wrapped.configs!["flat/all"] as Linter.Config;
  assert.equal(all.plugins!["fixture"], wrapped);

  // The upstream plugin's own config objects are untouched: still self-referential.
  const upstreamRecommended = (upstream.configs!["flat/recommended"] as Linter.Config[])[0]!;
  assert.equal(upstreamRecommended.plugins!["fixture"], upstream);
  assert.notEqual(recommended, upstreamRecommended);
  assert.notEqual(recommended.plugins, upstreamRecommended.plugins);
});

test("the single-object config form is rewritten and remains usable standalone", () => {
  const wrapped = tailor(makeUpstream(), [flagTailoring]);

  const messages = new Linter().verify("fixme;\n", [
    wrapped.configs!["flat/all"] as Linter.Config,
    { languageOptions: { ecmaVersion: 2022, sourceType: "module" } },
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.ruleId, "fixture/fixable-identifier");
  // The un-tailored fixable rule still behaves exactly like upstream.
  assert.deepEqual(
    messages,
    lintWith(fixableRule, "fixme;\n").map((m) => ({ ...m, ruleId: "fixture/fixable-identifier" })),
  );
});

test("a module naming an upstream rule the plugin lacks throws at load time, naming the module", () => {
  const missing = defineTailoredRule({
    tailors: "alt-txt",
    meta: { docs: { description: "rewrites alt-txt" } },
  });

  assert.throws(
    () => tailor(makeUpstream(), [flagTailoring, missing]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /alt-txt/);
      assert.match(error.message, /fixture-plugin/);
      assert.match(error.message, /index 1/);
      assert.match(error.message, /rewrites alt-txt/);
      return true;
    },
  );
});

test("tailoring the same upstream rule twice throws at load time", () => {
  const first = defineTailoredRule({
    tailors: "flag-identifier",
    meta: { docs: { description: "first tailoring" } },
  });
  const second = defineTailoredRule({
    tailors: "flag-identifier",
    meta: { docs: { description: "second tailoring" } },
  });

  assert.throws(
    () => tailor(makeUpstream(), [first, second]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /flag-identifier/);
      assert.match(error.message, /index 0/);
      assert.match(error.message, /index 1/);
      return true;
    },
  );
});

test("tailor() rejects values that are not tailored rule modules", () => {
  assert.throws(() => tailor(makeUpstream(), [flagRule as never]), /not a tailored rule/);
});

test("tailor() requires the name form; a direct-module tailoring is rejected with guidance", () => {
  const direct = defineTailoredRule({ tailors: flagRule });

  assert.throws(
    () => tailor(makeUpstream(), [direct]),
    /resolves upstream rules by name|tailors: "rule-name"/,
  );
});

test("rule ids, namespaces, and config keys never mention the tool", () => {
  const wrapped = tailor(makeUpstream(), [flagTailoring]);

  const surface: string[] = [
    ...Object.keys(wrapped.rules ?? {}),
    ...Object.keys(wrapped.configs ?? {}),
    wrapped.meta?.name ?? "",
    wrapped.meta?.version ?? "",
    wrapped.meta?.namespace ?? "",
  ];

  for (const value of Object.values(wrapped.configs ?? {})) {
    for (const config of Array.isArray(value) ? value : [value]) {
      surface.push(...Object.keys((config as Linter.Config).plugins ?? {}));
      surface.push(...Object.keys((config as Linter.Config).rules ?? {}));
    }
  }

  assert.doesNotMatch(surface.join("\n"), /pocket-tailor/i);
});

test("an empty tailoring list returns a plugin that is still a faithful copy", () => {
  const upstream = makeUpstream();
  const wrapped = tailor(upstream);

  assert.notEqual(wrapped, upstream);
  assert.deepEqual(Object.keys(wrapped.rules!).sort(), Object.keys(upstream.rules!).sort());
  for (const name of Object.keys(upstream.rules!)) {
    assert.equal(wrapped.rules![name], upstream.rules![name]);
  }
});

test("preserving meta.namespace keeps upstream's alias-based config remapping working", () => {
  const wrapped = tailor(makeUpstream(), [flagTailoring]);

  // Register the wrapped plugin under a DIFFERENT key than its meta.namespace.
  // `@eslint/config-helpers` rewrites `fixture/...` rule ids to `alias/...`
  // because `meta.namespace` is preserved; without it the rule would not resolve.
  const config = defineConfig([
    { plugins: { alias: wrapped }, extends: ["alias/recommended"] },
    { languageOptions: { ecmaVersion: 2022, sourceType: "module" } },
  ]);

  const messages = new Linter().verify("flag;\n", config);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.ruleId, "alias/flag-identifier");
  assert.equal(messages[0]!.message, "Tailored: do not use flag (bad)");
});
