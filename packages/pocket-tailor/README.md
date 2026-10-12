# Pocket Tailor

Wrap an existing ESLint plugin so its rules' reports can be tailored — rewrite
messages (including internal doc links as plain text) and add fixes or editor
suggestions — while the upstream plugin keeps sole ownership of detection.

It is the presentation counterpart to the other Pocket tools: Pocket Comb acts
on suppression directives, Pocket Zipper gates new suppression debt, and Pocket
Tailor changes what an upstream rule *says* and *offers*. A tailored rule is the
upstream rule's detection plus your presentation; detection is never copied,
forked, or re-implemented.

## Install

```sh
npm install --save-dev pocket-tailor
```

## Quick start

A tailored rule is a rule-shaped module: you declare which upstream rule it
tailors, write its `meta`, and shape each detection in `report()`.

```js
// lint/jsx-a11y/alt-text.js
import { defineTailoredRule } from "pocket-tailor";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default defineTailoredRule({
  tailors: jsxA11y.rules["alt-text"], // or the name "alt-text", resolved by tailor()

  meta: {
    messages: {
      missingAlt:
        "Missing alt text. Prefer the <Image> component — it handles alt text "
        + "for you. Guide: https://qeyora.dev/components/image#accessibility",
    },
  },

  // Fires once per upstream detection. Return a new report, or nothing to
  // forward the upstream report untouched.
  report(detection, helpers) {
    if (detection.messageId !== "missingAlt") return null;
    return { message: helpers.message("missingAlt", detection.data) };
  },
});
```

Because the composed rule is a real rule module, it tests with the standard
`RuleTester` and no harness:

```js
import { RuleTester } from "eslint";
import rule from "./alt-text.js";

new RuleTester().run("alt-text", rule, {
  valid: [{ code: '<img alt="Pocket logo" src="logo.png" />' }],
  invalid: [{ code: "<img src=\"logo.png\" />", errors: [{ messageId: "missingAlt" }] }],
});
```

## API

### `defineTailoredRule(definition)`

Returns a rule module (`meta` + `create`). `definition.tailors` is either the
upstream rule module (runnable immediately) or the upstream rule's name (a
declaration that `tailor()` composes once it resolves the name).

- `meta` — authored rule metadata; `messages` are merged over the upstream
  messages (the author wins on id collisions). The composed rule always keeps
  the upstream `schema` and `defaultOptions`.
- `report(detection, helpers)` — the single entry point, invoked once per
  upstream detection. Return a `TailoredReport` (message/messageId, data, node,
  loc, fix, suggest) or return nothing to pass the upstream report through
  untouched. There is no suppression mechanism.
- `autofix` — reserved for injected fixes (not yet implemented).

`helpers` exposes `message(id, data)` (ESLint's `{{placeholder}}`
interpolation), `sourceCode`, `options`, `filename`, and `settings`.

### `composeRule(upstreamRuleModule, definition)`

The engine primitive behind `defineTailoredRule`: compose a resolved upstream
rule module with a tailoring definition. Useful for wiring a name-form
declaration once the upstream rule is known.

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

## Out of scope

- Suppressing, filtering, or ranking detections — turn a rule off with ordinary
  ESLint severity config.
- Authoring detection — anything needing its own reports is a standalone custom
  rule, not a tailored rule.
- Renaming rules or managing severity — rule IDs, severities, path scoping, and
  option arrays stay plain ESLint config.
