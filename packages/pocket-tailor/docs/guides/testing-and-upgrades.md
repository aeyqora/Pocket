# Testing and upgrades

A tailored rule depends on upstream message ids, detection, and options. Pin
that dependency with a test that fails in the PR that upgrades the plugin.

## Get a runnable rule

A name-form tailored rule (`tailors: "no-widget"`) is a declaration. Its
`create()` throws until `tailor()` resolves the name. Tests compose it
explicitly:

```js
import { RuleTester } from "eslint";
import { composeRule, TAILORING } from "pocket-tailor";
import thing from "eslint-plugin-thing";
import tailored from "./no-widget.js";

const rule = composeRule(thing.rules["no-widget"], tailored[TAILORING]);
```

Alternatively, author the rule with the direct-module form
(`tailors: thing.rules["no-widget"]`). That returns a runnable rule with no
harness, at the cost of importing the plugin in the rule file. `tailor()`
accepts only the name form, so a direct-module rule cannot also be wrapped.

## Assert upstream still detects

Test the upstream rule's detection under its upstream message id, plus your
presentation:

```js
new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
}).run("thing/no-widget", rule, {
  valid: [{ code: "const ok = 1;" }],
  invalid: [
    {
      code: "const widget = 1;",
      output: null, // a suggestion, so --fix leaves the file alone
      errors: [
        {
          messageId: "noWidget", // upstream id, not a tailored one
          suggestions: [{ desc: "Apply the tailored fix.", output: "const Panel = 1;" }],
        },
      ],
    },
  ],
});
```

Keep one case per upstream message id you tailor, and one case for each fix or
suggestion contract you rely on. A rule using the basic `message` asserts the
rendered `message`; an id-based rule can assert `messageId`.

## Upgrade checklist

When bumping the wrapped plugin:

1. Run the package's tests. A rename, dropped detection, or changed option
   schema fails here.
2. Update `tailors`, message ids, `data` keys, or fix ranges that moved.
3. Re-run the tests before updating the dependency lockfile in the adoption PR.

Tests are the drift mechanism. There is no version pin or audit command in
v1; see [the README](../README.md#testing-tailored-rules) for the reasoning.
