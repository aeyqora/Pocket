# Changelog

All notable changes to `pocket-tailor` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-20

The first release: compose an upstream ESLint rule with an authored tailoring
definition so every upstream detection can carry a custom message — with the
upstream rule keeping sole ownership of detection.

### Added

- **`defineTailoredRule`** — declares a tailored rule, referencing its upstream
  rule either by name (resolved later by `tailor()`) or by direct rule module
  (runnable with `RuleTester` and no harness).
- **`tailor`** — wraps a plugin: returns a new plugin object shaped exactly like
  the upstream one, with each name-form tailored rule composed in place under the
  same rule ID and every named config under `configs` that embeds the plugin
  rewritten to point at the wrapper, so upstream recommended configs serve the
  tailored rules.
- **`composeRule`** — builds the composed rule module: the upstream `create()`
  runs detection and every upstream `context.report()` passes through the
  authored `report()` hook.
- **Injected fixes and suggestions** — an authored `fix` becomes an editor
  suggestion by default; `autofix: true` opts into a `--fix` autofix. A hook may
  also return `suggest` entries directly, and `suggestionDesc` /
  `suggestionMessageId` / `suggestionData` describe a converted fix.
- **Basic message override** — a top-level `message` replaces every detection's
  text, whether upstream reports with a `messageId` or a plain `message`. It
  interpolates upstream `data` with `{{placeholder}}`. A `report()` result wins
  per detection.
- **Per-message-id tailoring** — `meta.messages` overrides upstream templates by
  id; authored ids win on collisions.
- **Message interpolation** — `helpers.message(id, data)` reimplements ESLint's
  `{{placeholder}}` interpolation so upstream report data flows into custom
  messages.
- **Pass-through** — a hook that returns nothing forwards the upstream report
  untouched; no report can be suppressed.
- **Verbatim options** — the upstream `meta.schema` and `defaultOptions` are
  preserved, so configured options reach upstream detection unchanged.
- **Required documentation metadata** — every tailored rule must declare
  `meta.docs.description`, an absolute `http(s)` `meta.docs.url`, and at least
  one of `message`, `meta.messages`, or `report()`. Checked when the module
  loads, and again by `composeRule()` and `tailor()` so hand-built modules cannot
  bypass it.
- **Documentation and examples** — README quick start, task-oriented guides, and
  runnable basic and advanced config examples.

[0.1.0]: https://github.com/aeyqora/Pocket/releases/tag/pocket-tailor-v0.1.0
