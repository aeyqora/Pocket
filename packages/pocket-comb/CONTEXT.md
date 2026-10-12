# Pocket Comb

A CLI that performs mass ESLint suppression-directive operations — suppress, fix,
remove, replace, cleanup, and inventory — against a config-isolated ESLint instance, so
a team can drive suppression debt down (or deliberately up) in one auditable, reportable
pass. The acting counterpart to Pocket Zipper: the zipper gates new debt; the comb
performs the mass operations the gate's trends justify.

## Suppression model

Adopted wholesale from pocket-zipper's CONTEXT.md — the shared vocabulary of this
monorepo. **Suppression** = a disable-directive comment. **Directive forms** =
`next-line`, `line`, `block`, `file-level directive`. **Logical suppression** = one
`(rule, location)` pair a directive suppresses. See that package's glossary for the
full governance model (debt, guarded rule, fingerprint, tomb).

**Action**:
One of the six mass operations (`suppress`, `fix`, `remove`, `replace`, `cleanup`,
`inventory`). Chosen per run; never encoded in the action config — one config serves
any action.

**Action config**:
The single config file Pocket Comb loads: a standard ESLint flat config (its `rules`
name the rules to act on; its `languageOptions` do the parsing) plus a namespaced
tool block under `settings["pocket-comb"]`. Never to be confused with the **repo
config** — the target repository's own `eslint.config.*`, which Pocket Comb never
reads.

**Target**:
The directory tree an action runs against. Resolved in order: `--target` flag, wizard
answer, the action config's `target` setting, the current working directory.

**Guard**:
A directive positioned to suppress a violation at a given line — on the violation's
own line (the `line` form) or on the line above it (the `next-line` form).

**Minimal-span insert**:
The `suppress` default: every inserted directive suppresses exactly one line, even
when the violation sits inside a `block` span or under a `file-level` directive, so
suppression counts stay exact.

**Impact**:
What a dry run reports — the edits an action would make, per file, rule, and form,
before anything is written.

**Edit ledger**:
The per-edit record every report carries: file, line, rule, edit type, directive form,
before/after text.

**Census**:
The `inventory` action's complete count of every directive in the target, by rule,
form, and file. The suppression-trend measurement — censuses are diffed over time
wherever the team stores them; Pocket Comb keeps no history of its own runs.
