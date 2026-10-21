# API reference

All exports come from `pocket-tailor`.

## `tailor(upstreamPlugin, tailoredRuleModules)`

Wraps a plugin. Returns a new plugin object shaped exactly like
`upstreamPlugin`: every rule is carried over (un-tailored rules by object
identity), each name-form tailored rule module is composed in place under the
upstream rule ID, and every named config that embeds the plugin object is
rewritten to point at the wrapper. Rule IDs, `meta.namespace`, processors, and
languages are unchanged.

- `upstreamPlugin` — the original plugin object.
- `tailoredRuleModules` — modules built with `defineTailoredRule` whose
  `tailors` is the upstream rule's name. At most one module per upstream rule.
- A module naming a rule the plugin does not define, two modules naming the same
  rule, or a non-module value all throw at load time with the offending module
  named.

## `defineTailoredRule(definition)`

Declares a tailored rule. `definition.tailors` is either the upstream rule's
**name** inside the plugin it will be wrapped into (a *declaration* that
`tailor()` composes once it resolves the name) or the upstream rule **module**
(a fully runnable composed rule, for use without `tailor()`). A declaration's
`create()` throws until `tailor()` resolves it.

- `meta` — **required**. `meta.docs.description` (non-empty) and
  `meta.docs.url` (absolute `http`/`https`) are required. `messages` merge over
  the upstream messages and the author wins on id collisions. The composed rule
  always keeps the upstream `schema` and `defaultOptions`.
- `message` — one authored message for every detection, regardless of whether
  upstream reports with `messageId` or a plain `message`. Interpolates upstream
  `data` with `{{placeholder}}`. A `report()` result wins per detection.
- A definition must tailor presentation: a non-empty `message`, at least one
  non-empty `meta.messages` entry, or a `report()` hook. Every message value
  must be a non-empty string.
- `report(detection, helpers)` — the single entry point, invoked once per
  upstream detection. Return a `TailoredReport` to reshape the report, or
  nothing to pass the upstream report through untouched. Returning
  `{ message }` replaces the message id with literal text; leave it out to keep
  the upstream id. There is no suppression mechanism.
- `autofix` — `true` makes an authored `fix` a real `--fix` autofix (and
  synthesizes `meta.fixable`, reusing the upstream fix type). Omitted, an
  authored fix becomes an editor suggestion.
- `meta.fixable` is synthesized only under `autofix: true`. `meta.hasSuggestions`
  is declared whenever the rule is in suggestion mode (`autofix` omitted) or
  upstream already declares it. ESLint requires both flags statically on `meta`,
  before any report exists, so the composed rule declares the *capability* of
  its mode, not the presence of a fix or suggestion in a particular report.
- `suggestionDesc` / `suggestionMessageId` / `suggestionData` on a returned
  report describe the suggestion an authored fix becomes.

`defineTailoredRule()`, `composeRule()`, and `tailor()` all apply these guards at
load time. A missing description, a non-http(s) URL, or a rule with no `message`,
`meta.messages`, or hook throws with the rule named.

`helpers` exposes `message(id, data)` (resolves a message id against the
composed rule's messages and applies ESLint's `{{placeholder}}` interpolation),
`sourceCode`, `options`, `filename`, and `settings`.

## `composeRule(upstreamRuleModule, definition)`

The engine primitive behind `defineTailoredRule` and `tailor()`: compose a
resolved upstream rule module with a tailoring definition. Useful for wiring a
name-form declaration once the upstream rule is known, and for tests (see
[Testing and upgrades](testing-and-upgrades.md)).

## `TAILORING`

A symbol carried on every tailored rule module, holding its
`TailoringDefinition`. `tailor()` and tests read it to recover the declaration
from a module.

## Types

`TailoringDefinition` describes the authored module. `TailoringMeta` and
`TailoringDocs` describe its required metadata:

```ts
interface TailoringDocs {
  description: string;
  url: string; // absolute http(s)
}
```

`TailoringDocs`, `TailoringMeta`, `TailoringDefinition`, `Detection`,
`ReportHelpers`, and `ReportHook` are exported types.
