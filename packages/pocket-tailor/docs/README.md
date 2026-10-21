# Pocket Tailor documentation

Pocket Tailor wraps an existing ESLint plugin so you can rewrite what its rules
say and add a fix or editor suggestion, while the upstream plugin keeps sole
ownership of detection. Rule IDs, severities, options, and existing
`eslint-disable` comments stay valid.

The [package README](../README.md) is the overview, quick start, and API
reference. These guides cover the tasks that need more than a snippet.

## Guides

| Page | Read it when you want to… |
|---|---|
| [Authoring a tailored rule](guides/authoring-a-tailored-rule.md) | Write a rule: messages, the report hook, fixes, suggestions, and pass-through. |
| [Adopting in a repo](guides/adopting-in-a-repo.md) | Choose where rules live, wrap the plugin, migrate, or revert one rule. |
| [Testing and upgrades](guides/testing-and-upgrades.md) | Lock a tailored rule to upstream detection and handle a plugin upgrade. |
| [API reference](guides/api.md) | Look up `tailor`, `defineTailoredRule`, `composeRule`, and helpers. |
| [Why wrap, and the boundaries](guides/why-wrap.md) | Compare wrapping with forking and see what the tool will not do. |
| [Troubleshooting](guides/troubleshooting.md) | Turn a load-time error or a missing message/fix into a specific fix. |

Start with the [package README](../README.md) for install and the quick start.

## Examples

- [`examples/basic`](../examples/basic) — the shortest adoption: one tailored
  rule and one inline config. No external plugin dependency.
- [`examples/advanced`](../examples/advanced) — a separate config module built
  from an upstream `flatConfigs.strict` preset, with the wrapped plugin swapped
  in. This is the `jsx-a11y.flatConfigs.strict` pattern.

## The model

A tailored rule has three parts: the upstream rule it targets (`tailors`), the
text it presents (a basic `message`, per-id `meta.messages`, or a `report()`
hook), and its required docs metadata (`meta.docs.description` and
`meta.docs.url`). Detection comes from upstream, always. A hook that returns
nothing passes the upstream report through unchanged. There is no suppression
mechanism; enforcement is ordinary ESLint config.

A tailored rule cannot add, remove, or suppress detections. If you need new
detection, write a standalone custom rule.

For the full vocabulary, see [CONTEXT.md](../CONTEXT.md).
