# Pocket Tailor

Wrap an existing ESLint plugin so you can tailor what its rules *say* and
*offer* — rewrite messages (including embedding internal doc links as plain
text) and add a fix or editor suggestion — while the upstream plugin keeps sole
ownership of detection.

A tailored rule is the upstream rule's detection plus your presentation.
Detection is never copied, forked, or re-implemented: if the upstream rule
flags something, the report survives (possibly reworded); if upstream does not
flag it, nothing appears. It is the presentation counterpart to the other
Pocket tools: Pocket Comb acts on suppression directives, Pocket Zipper gates
new suppression debt, and Pocket Tailor changes an upstream rule's output.

Because rules keep their upstream IDs and plugins are wrapped in place,
adoption is a one-line change: existing `eslint-disable` comments, severities,
options, and config ordering all stay valid.

## Install

```sh
npm install --save-dev pocket-tailor
```

## Quickstart

Three steps: author a tailored rule file, call `tailor()` once in the consuming
config, and extend the upstream plugin's recommended config as usual. This
example targets a hypothetical `eslint-plugin-thing` and a local `<Panel>`
component.

### 1. Author a tailored rule file

A tailored rule is rule-shaped: declare which upstream rule it tailors, write
its `meta`, and optionally shape each detection in `report()`.

```js
// lint/thing/no-widget.js
import { defineTailoredRule } from "pocket-tailor";

export default defineTailoredRule({
  // The upstream rule's id inside eslint-plugin-thing.
  tailors: "no-widget",

  meta: {
    // Authored messages merge over the upstream messages under the same id.
    // A report that passes through renders this text; {{name}} is
    // interpolated from the upstream report data.
    messages: {
      noWidget:
        "Do not use <{{name}}>. Prefer the <Panel> component — it handles "
        + "labelling for you. Guide: https://example.dev/components/panel",
    },
  },

  // Fires once per upstream detection. Return a report to reshape it, or
  // nothing to forward the upstream report untouched.
  report(detection) {
    if (detection.messageId !== "noWidget") return null;
    return {
      // Fields you leave out are inherited — here the message id, data, and
      // location all come from upstream. An authored fix becomes an editor
      // suggestion unless this rule declares `autofix: true` (ADR-0003).
      fix: (fixer) => fixer.replaceText(detection.node, "Panel"),
    };
  },
});
```

### 2. Wrap the plugin once in the consuming config

`tailor()` returns a new plugin object shaped exactly like the upstream one,
with the tailored rules swapped in place under the same rule IDs. Register that
object under the plugin's namespace before any config spreads it.

```js
// eslint.config.js
import { defineConfig } from "eslint/config";
import thing from "eslint-plugin-thing";
import { tailor } from "pocket-tailor";
import noWidget from "./lint/thing/no-widget.js";

const tailoredThing = tailor(thing, [noWidget]);

export default defineConfig([
  // 3. Extend the upstream plugin's recommended config as usual. It now
  //    serves the tailored rules automatically.
  ...tailoredThing.configs["flat/recommended"],
  {
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    rules: {
      // Severity and upstream options are plain ESLint config.
      "thing/no-widget": ["error", { also: ["gadget"] }],
    },
  },
]);
```

There are no off/on rule pairs, no config-ordering tricks, and no parallel rule
lists. Flat config forbids registering two different objects under one
namespace (`Cannot redefine plugin`), so the wrap happens on the plugin object
before any config uses it; upstream configs then back the tailored rules.

## Worked adoption example

A tailored rule module is location-agnostic (ADR-0005): the same module shape
works whether the file lives in your repo or is exported by a package you
already depend on. `tailor()` accepts any mix of sources in one call, so a repo
can tailor its own rules and consume shared ones together.

### (a) Repo-local tailored files

Repo-local rules are for repo-specific components and docs. The file above
(`./lint/thing/no-widget.js`) is one: it references the local `<Panel>` and the
repo's own guide URL, so it belongs in the repo.

### (b) Tailored rules from a package you already depend on

A shared package — here the hypothetical `@acme/thing-rules`, already a
dependency — can export tailored rule modules alongside the components they
reference. The module is written exactly the same way:

```js
// @acme/thing-rules/thing/prefer-panel.js
import { defineTailoredRule } from "pocket-tailor";

export default defineTailoredRule({
  tailors: "prefer-panel",
  meta: {
    messages: {
      usePanel:
        "Use <Panel> instead of <{{name}}>. Panel guidance: "
        + "https://example.dev/components/panel",
    },
  },
});
```

```js
// @acme/thing-rules/index.js
export { default as preferPanel } from "./thing/prefer-panel.js";
```

### Mixing both in one `tailor()` call

The consuming repo passes the repo-local module and the shared one to the same
call:

```js
// eslint.config.js
import { defineConfig } from "eslint/config";
import thing from "eslint-plugin-thing";
import { tailor } from "pocket-tailor";
import noWidget from "./lint/thing/no-widget.js";   // repo-local
import { preferPanel } from "@acme/thing-rules";     // already a dependency

export default defineConfig([
  ...tailor(thing, [noWidget, preferPanel]).configs["flat/recommended"],
  {
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
  },
]);
```

Location follows ownership: shared rules ship with the package that owns the
components they reference and are versioned with it; repo-local rules belong to
the repo. Deleting a tailored rule file affects only the package or repo that
owns it — consumers fall back to the untouched upstream rule.

## Why wrap instead of fork

1. **Detection is universal; remediation is local.** The upstream rule flags
   the same patterns for everyone; the fix ("use our `<Panel>`", "see our
   guide") is specific to your codebase. Wrapping expresses exactly that split.
   A custom rule or fork conflates the two and forces you to copy detection
   logic you do not need to change.
2. **A fork starts drifting the day it is copied.** Upstream fixes false
   positives and ships spec updates; a stale fork is a liability. Wrapping
   stays in lockstep by construction — upgrading is a version bump.
3. **The cost is asymmetric.** Reimplementing plugin-grade maturity takes
   months and is never finished; wrapping takes days. Rules that are fine as-is
   cost nothing at all.
4. **It is the established pattern.** typescript-eslint's extension rules and
   `@eslint/compat`'s `fixupRule` both wrap and reuse upstream detection instead
   of rewriting it.

The one honest risk is coupling to upstream's message ids and option schema. It
is a dependency-management risk with an ordinary answer — the RuleTester
coverage described under [Testing tailored rules](#testing-tailored-rules) —
and it is far smaller than owning a permanent fork.

## API

### `tailor(upstreamPlugin, tailoringModules)`

Wraps a plugin. Returns a new plugin object shaped exactly like `upstreamPlugin`:
every rule is carried over (un-tailored rules by object identity), each name-form
tailoring module is composed in place under the upstream rule ID, and every
named config that embeds the plugin object is rewritten to point at the wrapper.
Rule IDs, `meta.namespace`, processors, and languages are unchanged.

- `upstreamPlugin` — the original plugin object.
- `tailoringModules` — modules built with `defineTailoredRule` whose `tailors`
  is the upstream rule's name. At most one module per upstream rule.
- A module naming a rule the plugin does not define, two modules naming the same
  rule, or a non-module value all throw at load time with the offending module
  named.

### `defineTailoredRule(definition)`

Declares a tailored rule. `definition.tailors` is either the upstream rule's
**name** inside the plugin it will be wrapped into (a *declaration* that
`tailor()` composes once it resolves the name) or the upstream rule **module**
(a fully runnable composed rule, for use without `tailor()`). A declaration's
`create()` throws until `tailor()` resolves it.

- `meta` — authored rule metadata; `messages` merge over the upstream messages
  and the author wins on id collisions. The composed rule always keeps the
  upstream `schema` and `defaultOptions`.
- `report(detection, helpers)` — the single entry point, invoked once per
  upstream detection. Return a `TailoredReport` to reshape the report, or
  nothing to pass the upstream report through untouched. Returning
  `{ message }` replaces the message id with literal text; leave it out to keep
  the upstream id. There is no suppression mechanism.
- `autofix` — `true` makes an authored `fix` a real `--fix` autofix (and
  synthesizes `meta.fixable`, reusing the upstream fix type). Omitted, an
  authored fix becomes an editor suggestion (ADR-0003).
- `suggestionDesc` / `suggestionMessageId` / `suggestionData` on a returned
  report describe the suggestion an authored fix becomes.

`helpers` exposes `message(id, data)` (resolves a message id against the
composed rule's messages and applies ESLint's `{{placeholder}}` interpolation),
`sourceCode`, `options`, `filename`, and `settings`.

### `composeRule(upstreamRuleModule, definition)`

The engine primitive behind `defineTailoredRule` and `tailor()`: compose a
resolved upstream rule module with a tailoring definition. Useful for wiring a
name-form declaration once the upstream rule is known, and for tests (see
[Testing tailored rules](#testing-tailored-rules)).

### `TAILORING`

A symbol carried on every tailored rule module, holding its
`TailoringDefinition`. `tailor()` and tests read it to recover the declaration
from a module.

## Migration guide

### Adopting

Point the plugin registration at the wrapped plugin. That is the whole change —
one line, because `tailor()` preserves the rule IDs and rewrites the plugin's
own configs:

```diff
-import thing from "eslint-plugin-thing";
+import thing from "./lint/tailored-thing.js"; // tailor(realThing, [...]) lives here
```

Recommended configs, severities, options, and existing `eslint-disable`
comments are untouched.

### Reverting a single rule to upstream

Remove that rule's module from the list passed to `tailor()`:

```diff
-const tailoredThing = tailor(thing, [noWidget, preferPanel]);
+const tailoredThing = tailor(thing, [noWidget]);
```

The upstream rule then serves that rule ID untouched — fallback is seamless, no
config change needed. (Deleting a shared rule from the package that owns it has
the same effect for its consumers.)

### Controlling enforcement

Whether a rule runs, where, and how loudly is ordinary ESLint config:
severity `off`/`warn`/`error`, path scoping with `files`/`ignores`, and the
upstream rule's own option array. Pocket Tailor adds nothing here.

```js
{
  files: ["src/**/*.tsx"],
  rules: {
    "thing/no-widget": "warn",
    "thing/prefer-panel": ["error", { also: ["gadget"] }],
  },
}
```

### Existing `eslint-disable` comments

Rule IDs are identical to upstream (ADR-0001), so every disable comment, CI
reference, and editor shortcut written against `thing/no-widget` keeps working
unchanged:

```js
// eslint-disable-next-line thing/no-widget
const widget = 1;
```

## Testing tailored rules

A tailored rule is a rule-shaped module, so it tests with the standard
`RuleTester` and no harness. Because a name-form tailored rule is a declaration,
`tailor()` composes it later and its `create()` throws until then; a test must
obtain a runnable rule one of two ways:

- compose it explicitly with `composeRule(upstreamRuleModule, tailored[TAILORING])`, or
- write that rule's definition with the direct-module form
  (`tailors: thing.rules["no-widget"]`), which returns a runnable composed rule.
  The direct-module form is for direct use; `tailor()` accepts only name-form
  modules, because it resolves names from the plugin it wraps.

Write one test per tailored rule that asserts the upstream rule still detects
under the same message id, so an upstream upgrade fails loudly instead of
silently:

```js
// lint/thing/no-widget.test.js
import { RuleTester } from "eslint";
import { composeRule, TAILORING } from "pocket-tailor";
import thing from "eslint-plugin-thing";
import tailored from "./no-widget.js";

// The name-form declaration, composed for the test.
const rule = composeRule(thing.rules["no-widget"], tailored[TAILORING]);

new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module" } }).run(
  "thing/no-widget",
  rule,
  {
    valid: [{ code: "const ok = 1;" }],
    invalid: [
      {
        code: "const widget = 1;",
        output: null, // the authored fix is a suggestion; --fix leaves the file alone
        errors: [
          {
            messageId: "noWidget", // upstream still detects under this id
            suggestions: [
              { desc: "Apply the tailored fix.", output: "const Panel = 1;" },
            ],
          },
        ],
      },
    ],
  },
);
```

If a PR bumps `eslint-plugin-thing` and upstream renames the message id, changes
what it flags, or drops the detection, this test fails in that upgrade PR.

## Boundaries

Pocket Tailor reshapes presentation only (ADR-0004).

- **No suppression.** Returning nothing from `report()` is pass-through, never
  suppression; there is no suppress mechanism of any kind. To stop enforcing a
  rule, set its severity to `off` in ordinary ESLint config.
- **No severity logic.** Severity, `files`/`ignores` scoping, and option arrays
  are plain ESLint config; the tool adds nothing here.
- **No added detection.** The tool cannot add reports or run its own AST
  listeners. Anything that needs its own detection is a standalone custom rule,
  not a tailored rule.

## Requirements

- **Node.js** 20.12 or newer.
- **ESLint** 9.34 or newer, flat config only. A required peer dependency.

## Development

```sh
npm install
npm run build        # tsc -> dist
npm run typecheck    # tsc --noEmit
npm test             # node:test suite (run via tsx)
```
