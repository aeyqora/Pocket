# Troubleshooting

Every load-time error names the module and the rule. Start with the message.

## Load-time errors

| Message contains | Cause | Fix |
|---|---|---|
| `has not been resolved` | A name-form rule ran without `tailor()`. | Compose it with `tailor()` or `composeRule()`, or use the direct-module form in tests. |
| `names upstream rule 'x', which plugin 'y' does not define` | `tailors` does not match a rule id in the wrapped plugin. | Use the id from `plugin.rules` (without the namespace) and check the plugin version. |
| `is tailored by more than one module` | Two modules target the same upstream rule. | Keep one; move the other to a different rule or merge them. |
| `cannot be resolved: tailor() resolves upstream rules by name` | A direct-module rule was passed to `tailor()`. | Change it to `tailors: "rule-name"`. |
| `was given a value that is not a tailored rule module` | The array holds `undefined`, a rule module, or an unbuilt module. | Export the result of `defineTailoredRule` and check the import path. |
| `must declare meta.docs` | The rule has no `meta.docs`. | Add `description` and `url`. |
| `non-empty meta.docs.description` | Description is missing or blank. | Write a short summary of what the rule enforces. |
| `absolute http(s) meta.docs.url` | URL is missing, relative, or uses another scheme. | Use a full `https://` or `http://` URL. |
| `must tailor presentation` | No `message`, `meta.messages`, or `report()`. | Add one; a docs-only rule is a no-op. |
| `non-empty message` | The basic `message` is blank. | Give it text. |
| `empty message for` | A `meta.messages` value is blank. | Give every message non-empty text. |
| `report as a function` | `report` is present but not callable. | Set `report` to a function or remove it. |
| `Cannot redefine plugin` (from ESLint) | The upstream plugin and the wrapped plugin are registered under the same namespace. | Register only the object returned by `tailor()`. |

## The message is unchanged

- The hook returned `null` for that detection. Check the `messageId` condition.
- The returned `{ messageId }` is not in `meta.messages` and not upstream.
- Two modules target the same rule; the load-time error should have caught it.
- With a basic `message`, check the hook is not returning its own `message` or
  `messageId`; a hook message wins per detection.

To confirm which id upstream emits, run the upstream rule alone or log
`detection.messageId` in the hook.

## The fix or suggestion is missing

| Symptom | Cause |
|---|---|
| No suggestion at all | The hook returned no `fix` and no `suggest`. |
| `--fix` does nothing | `autofix` is omitted; the fix is a suggestion by design. |
| Suggestion description is generic | Add `suggestionDesc`, or `suggestionMessageId` + `suggestionData`. |
| `Fix has invalid range` or the range error names your rule | The fixer returned a range outside the file, or built it from stale node positions. |

Changing `filename`-conditional presentation also changes what appears in a
test. Use the real filename or accept the default branch.

## Options are rejected or ignored

Options and `meta.schema` are upstream's. The composed rule forwards the
configured array verbatim and keeps upstream's schema. A validation error means
the option shape is wrong for upstream, not for Pocket Tailor. Tailoring cannot
add or change option semantics.

## The editor still links upstream docs

The editor link comes from the composed rule's `meta.docs.url`. Verify the rule
first:

```sh
node --input-type=module -e "
import plugin from 'eslint-plugin-thing';
import rule from './lint/thing/no-widget.js';
import { tailor } from 'pocket-tailor';
console.log(tailor(plugin, [rule]).rules['no-widget'].meta.docs);
"
```

If that prints your URL, the ESLint editor extension is caching rule metadata by
rule id. Restart the ESLint server, save the rule file (this clears the cache),
and reload the window. A URL in the message text is plain text; it does not
replace `meta.docs.url`.

## Enforcement

Severity, `files`/`ignores`, and inline disable comments are ordinary ESLint
config. If a rule does not run where you expect, check the config's `files`
patterns and any `eslint-disable` comments. Pocket Tailor never suppresses a
report.
