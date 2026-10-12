# Changelog

All notable changes to `pocket-tailor` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-12

The first release: compose an upstream ESLint rule with an authored tailoring
definition so every upstream detection can carry a custom message — with the
upstream rule keeping sole ownership of detection.

### Added

- **`defineTailoredRule`** — declares a tailored rule, referencing its upstream
  rule either by name (resolved later by `tailor()`) or by direct rule module
  (runnable with `RuleTester` and no harness).
- **`tailor`** — wraps a plugin: returns a new plugin object shaped exactly like
  the upstream one, with each name-form tailored rule composed in place under the
  same rule ID and every named config that embeds the plugin rewritten to point
  at the wrapper, so upstream recommended configs serve the tailored rules.
- **`composeRule`** — builds the composed rule module: the upstream `create()`
  runs detection and every upstream `context.report()` passes through the
  authored `report()` hook.
- **Injected fixes and suggestions** — an authored `fix` becomes an editor
  suggestion by default; `autofix: true` opts into a `--fix` autofix. A hook may
  also return `suggest` entries directly, and `suggestionDesc` /
  `suggestionMessageId` / `suggestionData` describe a converted fix.
- **Message interpolation** — `helpers.message(id, data)` reimplements ESLint's
  `{{placeholder}}` interpolation so upstream report data flows into custom
  messages.
- **Pass-through** — a hook that returns nothing forwards the upstream report
  untouched; no report can be suppressed.
- **Verbatim options** — the upstream `meta.schema` and `defaultOptions` are
  preserved, so configured options reach upstream detection unchanged.

[0.1.0]: https://github.com/aeyqora/Pocket/commits/main/packages/pocket-tailor
