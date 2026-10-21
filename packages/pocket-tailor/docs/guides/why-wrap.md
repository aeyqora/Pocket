# Why wrap, and the boundaries

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
coverage described in [Testing and upgrades](testing-and-upgrades.md) — and it
is far smaller than owning a permanent fork.

## Boundaries

Pocket Tailor reshapes presentation only.

- **No suppression.** Returning nothing from `report()` is pass-through, never
  suppression; there is no suppress mechanism of any kind. To stop enforcing a
  rule, set its severity to `off` in ordinary ESLint config.
- **No severity logic.** Severity, `files`/`ignores` scoping, and option arrays
  are plain ESLint config; the tool adds nothing here.
- **No added detection.** The tool cannot add reports or run its own AST
  listeners. Anything that needs its own detection is a standalone custom rule,
  not a tailored rule.

If the upstream rule does not flag what you need, stop and write a custom rule.
If it flags too much, use severity, `files`/`ignores`, or the upstream rule's
options. A tailored rule only changes what an existing detection says or offers.

Every tailored rule must also declare `meta.docs.description` and
`meta.docs.url` (absolute http/https), plus a basic `message`, at least one
`meta.messages` entry, or a `report()` hook. The guards run when the module
loads.

The full domain vocabulary is in [CONTEXT.md](../../CONTEXT.md).
