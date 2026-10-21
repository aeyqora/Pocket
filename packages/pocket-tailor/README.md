# Pocket Tailor

Wrap an existing ESLint plugin so you can tailor what its rules *say* and
*offer* — rewrite messages (including embedding internal doc links as plain
text) and add a fix or editor suggestion — while the upstream plugin keeps sole
ownership of detection.

A tailored rule is the upstream rule's detection plus your presentation.
Detection is never copied, forked, or re-implemented: if upstream flags
something, the report survives (possibly reworded); if upstream does not flag
it, nothing appears. It is the presentation counterpart to the other Pocket
tools: Pocket Comb acts on suppression directives, Pocket Zipper gates new
suppression debt, and Pocket Tailor changes an upstream rule's output.

Because rules keep their upstream IDs and plugins are wrapped in place,
adoption is a one-line change: existing `eslint-disable` comments, severities,
options, and config ordering all stay valid.

## Install

```sh
npm install --save-dev pocket-tailor
```

Requires Node.js 20.12 or newer and ESLint 9.34 or newer (flat config only).
ESLint is a peer dependency.

## Quick start

Wrap the plugin once, then tell one upstream rule what to say and how to fix it.
The example uses a hypothetical `eslint-plugin-thing` and a local `<Panel>`
component.

### 1. Author a tailored rule

```js
// lint/thing/no-widget.js
import { defineTailoredRule } from "pocket-tailor";

export default defineTailoredRule({
  tailors: "no-widget",

  // One message for every detection. `{{name}}` is interpolated from the
  // upstream report data. No need to know whether upstream uses a messageId.
  message:
    "Do not use <{{name}}>. Prefer the <Panel> component. "
    + "Guide: https://example.dev/components/panel",

  // Required: powers the editor's rule link.
  meta: {
    docs: {
      description: "Block widget elements in favour of Panel.",
      url: "https://example.dev/components/panel",
    },
  },

  // Make the authored fix a real `--fix` rewrite. Omit this for an editor
  // suggestion instead.
  autofix: true,

  report(detection) {
    if (detection.messageId !== "noWidget") return null;
    return { fix: (fixer) => fixer.replaceText(detection.node, "Panel") };
  },
});
```

### 2. Wrap the plugin in the ESLint config

```js
// eslint.config.js
import { defineConfig } from "eslint/config";
import thing from "eslint-plugin-thing";
import { tailor } from "pocket-tailor";
import noWidget from "./lint/thing/no-widget.js";

const tailoredThing = tailor(thing, [noWidget]);

export default defineConfig([
  // Upstream's recommended config now serves the tailored rules automatically.
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

```sh
npx eslint --fix src/
```

Rule IDs stay unchanged, so existing severities, options, and
`eslint-disable` comments keep working.

## Advanced options

| Want to… | Use |
|---|---|
| Different wording per upstream message id | `meta.messages` |
| Shape one detection conditionally | `report(detection, helpers)` |
| Add an editor suggestion instead of an autofix | Omit `autofix`; optionally add `suggestionDesc`, `suggestionMessageId`, or `suggest` |
| Keep rules in the repo or ship them in a package | Repo-local or shared tailored modules; `tailor()` accepts both |
| Start from an upstream preset such as a plugin's `flatConfigs.strict` | Use the preset's rules and swap its `plugins` entry for the wrapped plugin |
| Catch upstream drift | Compose with `composeRule` and assert the upstream message id in `RuleTester` |

See [Authoring a tailored rule](docs/guides/authoring-a-tailored-rule.md) for
per-message-id tailoring, finding upstream `messageId`s, hooks, suggestions, and
the full precedence rules. [Adopting in a repo](docs/guides/adopting-in-a-repo.md)
covers inline versus separate config modules and upstream presets.

## Documentation

The package README is the overview; the guides cover the tasks in full.

| Page | Read it when you want to… |
|---|---|
| [Documentation index](docs/README.md) | See the model and every guide. |
| [Authoring a tailored rule](docs/guides/authoring-a-tailored-rule.md) | Write messages, hooks, fixes, and suggestions. |
| [Adopting in a repo](docs/guides/adopting-in-a-repo.md) | Choose where rules live, migrate, or revert a rule. |
| [Testing and upgrades](docs/guides/testing-and-upgrades.md) | Lock a rule to upstream detection and handle upgrades. |
| [API reference](docs/guides/api.md) | Look up `tailor`, `defineTailoredRule`, `composeRule`, and helpers. |
| [Why wrap, and the boundaries](docs/guides/why-wrap.md) | Compare with a fork and see what the tool will not do. |
| [Troubleshooting](docs/guides/troubleshooting.md) | Turn an error or a missing message/fix into a fix. |
| [Basic example](examples/basic/README.md) | Run a wrapped plugin locally. |
| [Advanced example](examples/advanced/README.md) | Start from an upstream strict preset in a separate config module. |

## Development

```sh
npm install
npm run build        # tsc -> dist
npm run typecheck    # tsc --noEmit
npm test             # node:test suite (run via tsx)
```
