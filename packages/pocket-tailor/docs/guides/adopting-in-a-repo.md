# Adopting in a repo

Adoption is one line: register the wrapped plugin instead of the upstream one.
Start with everything inline. Move to a separate config module when you want to
reuse an upstream config such as `jsx-a11y` strict.

## Basic: everything inline

One tailored rule file, one wrapped plugin, one config.

```js
// lint/jsx-a11y/no-static-element-interactions.js
import { defineTailoredRule } from "pocket-tailor";

export default defineTailoredRule({
  tailors: "no-static-element-interactions",
  message:
    "Use a native interactive element (<button>, <a>) or add role and keyboard "
    + "handlers. Guide: https://example.dev/a11y/interactive-elements",
  meta: {
    docs: {
      description: "Use native interactive elements.",
      url: "https://example.dev/a11y/interactive-elements",
    },
  },
});
```

```js
// eslint.config.js
import jsxA11y from "eslint-plugin-jsx-a11y";
import { tailor } from "pocket-tailor";
import noStaticElementInteractions from "./lint/jsx-a11y/no-static-element-interactions.js";

const tailoredJsxA11y = tailor(jsxA11y, [noStaticElementInteractions]);

export default [
  {
    files: ["**/*.jsx"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "jsx-a11y": tailoredJsxA11y },
    rules: {
      "jsx-a11y/no-static-element-interactions": "error",
    },
  },
];
```

That is enough for adoption. Rule IDs are unchanged, so severities,
`eslint-disable` comments, and editor shortcuts keep working.

## Advanced: separate config module

Use a separate module when the config should start from an upstream preset, or
when several configs share the tailored plugin. The common case is
`jsx-a11y.flatConfigs.strict`.

```js
// lint/jsx-a11y/html-has-lang.js
import { defineTailoredRule } from "pocket-tailor";

export default defineTailoredRule({
  tailors: "html-has-lang",
  autofix: true,
  meta: {
    docs: {
      description: "Require a language on the root html element.",
      url: "https://example.dev/a11y/html-language",
    },
  },
  report(detection) {
    return {
      fix: (fixer) => fixer.insertTextAfter(detection.node.name, ' lang="en"'),
    };
  },
});
```

```js
// lint/jsx-a11y/config.js
import jsxA11y from "eslint-plugin-jsx-a11y";
import { tailor } from "pocket-tailor";
import noStaticElementInteractions from "./no-static-element-interactions.js";
import htmlHasLang from "./html-has-lang.js";

export const tailoredJsxA11y = tailor(jsxA11y, [
  noStaticElementInteractions,
  htmlHasLang,
]);

// jsx-a11y's own strict rule set, served by the tailored plugin.
export const jsxA11yStrict = {
  ...jsxA11y.flatConfigs.strict,
  name: "app/jsx-a11y-strict-tailored",
  files: ["**/*.jsx"],
  plugins: { "jsx-a11y": tailoredJsxA11y },
};
```

```js
// eslint.config.js
import { defineConfig } from "eslint/config";
import { jsxA11yStrict } from "./lint/jsx-a11y/config.js";

export default defineConfig([
  jsxA11yStrict,
  {
    files: ["**/*.jsx"],
    rules: {
      // Strict already enables the rules; add overrides here.
      "jsx-a11y/no-static-element-interactions": ["error", { handlers: ["onClick"] }],
    },
  },
]);
```

Start from `jsx-a11y.flatConfigs.strict`, then replace its `plugins` entry with
the wrapped object. Do not use `tailoredJsxA11y.flatConfigs.strict` directly:
`tailor()` remaps named `configs`, but `flatConfigs` is a separate map that still
points at the original plugin. The explicit module above makes the swap visible.

The same shape works for `flatConfigs.recommended`; export a second named config
from the same module if you need both.

## Where tailored rules live

A tailored rule module is location-agnostic: the same module shape works whether
the file lives in your repo or is exported by a package you already depend on.
`tailor()` accepts any mix in one call.

**Repo-local** rules are for repo-specific components and docs:

```js
// lint/thing/no-widget.js
export default defineTailoredRule({
  tailors: "no-widget",
  message: "Use <Panel> instead of <{{name}}>.",
  meta: {
    docs: {
      description: "Use the local Panel component.",
      url: "https://example.dev/components/panel",
    },
  },
});
```

**Shared** rules ship with the package that owns the components they reference:

```js
// @acme/thing-rules/thing/prefer-panel.js
import { defineTailoredRule } from "pocket-tailor";

export default defineTailoredRule({
  tailors: "prefer-panel",
  meta: {
    docs: {
      description: "Prefer the shared Panel component.",
      url: "https://example.dev/components/panel",
    },
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

The consuming repo mixes both sources:

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

Deleting a tailored rule file affects only the package or repo that owns it;
consumers fall back to the untouched upstream rule.

## Migrating

### Adopting

Point the plugin registration at the wrapped plugin. That is the whole change:

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

The upstream rule then serves that rule ID untouched. No config change is
needed. Deleting a shared rule has the same effect for its consumers.

### Controlling enforcement

Whether a rule runs, where, and how loudly is ordinary ESLint config: severity
`off`/`warn`/`error`, path scoping with `files`/`ignores`, and the upstream
rule's own option array. Pocket Tailor adds nothing here.

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

Rule IDs are identical to upstream, so every disable comment, CI reference, and
editor shortcut written against `thing/no-widget` keeps working:

```js
// eslint-disable-next-line thing/no-widget
const widget = 1;
```
