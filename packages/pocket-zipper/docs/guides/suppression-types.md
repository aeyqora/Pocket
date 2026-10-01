# What the gate counts

Pocket Zipper gates **suppression debt**, and the cheapest way to get surprised is to
discover what counts as a suppression. There are five shapes, in two families:

- **Directives** — comments in your code that switch ESLint rules off: `next-line`,
  `line`, `block`, and `file-level directive`.
- **Config-level** — a rule set to `"off"` in your flat config (`config-off`).

Lowering a governed rule to `"warn"` isn't a suppression (the rule still fires), but it is
the same family of policy change — see [Severity drops](#severity-drops--a-policy-change-with-no-suppression).

A directive is debt even when it guards nothing that currently fires. The gate counts the
directive, not the diagnostic.

## The five shapes

### `next-line` — the next line only

```js
// eslint-disable-next-line no-console
console.log("hi"); // the guarded line
```

### `line` — the line it sits on

```js
console.log("hi"); // eslint-disable-line no-console
```

A `line` directive that spans multiple lines is refused by ESLint and counts as nothing.

### `block` — a closed region

```js
/* eslint-disable no-console */
console.log("a");
console.log("b");
/* eslint-enable no-console */
```

The region runs from the `disable` to the matching `enable`. A named `eslint-enable`
re-opens only the rules it names, so `disable a, b` followed by `enable a` leaves `b`
suppressed to the end of the file — ESLint's own semantics.

### `file-level directive` — open to the end of the file

```js
/* eslint-disable no-console */
console.log("a");
console.log("b"); // still suppressed
```

An `eslint-disable` block that is never closed guards from the `disable` to the last line
of the file. This is the broad file-level shape teams usually want to avoid: it makes the
debt invisible and hard to remove.

### `config-off` — off in the flat config

```yaml
rules:
  no-console: off
```

A rule set to `"off"` (severity 0) in `eslint.config.*` is a suppression like any other,
scoped to the `files`/`ignores` patterns it sits under, and skipped when a later global
`on` (or a same-scope `on`) re-enables it. It is **not exceptable**: the exception
registry accepts only the four directive types, so no exception record can authorize a
`config-off`.

A new `config-off` is a **policy change**, not debt. The gate records it
(`POLICY_CHANGE`) and passes on its own — the config edit then goes through review like
any policy edit. It fails the gate only when the *same change* also introduces new
directive debt: that's a weakening consumed by debt, the same self-dealing the gate
blocks for `.pocket-zipper` allowlist narrowing. An `off` for a rule the `governedRules`
allowlist never governed changes nothing and isn't even recorded.

Unless a severity floor covers the rule: a `minSeverities` entry for it turns the step down
into a gate failure of its own (`SEVERITY_FLOOR`, exit 1). See
[Severity floors](#severity-floors--when-a-drop-is-a-failure).

### Severity drops — a policy change with no suppression

Lowering a governed rule from `"error"` to `"warn"` is a policy change too — no
`config-off` is created (the rule still runs and its violations still fire), but the
enforcement surface got weaker. The gate flags it the same way:

```diff
  rules:
-   no-console: error
+   no-console: warn
```

Severity has three bands, weakest to strongest: `off` (0), `warn` (1), `error` (2). Any
move **down** that ladder for a rule the baseline governed — `error` → `warn`,
`warn` → `off`, `error` → `off` — records a `POLICY_CHANGE`. Moves up (`warn` → `error`)
are strengthening and record nothing.

Two differences from a `config-off` keep the semantics honest:

- **A warn rule is still gated.** `"warn"` is a live severity, so directives for that rule
  are still recognized and counted. Turning a rule off hides its directives; lowering it
  to `"warn"` does not.
- **Scope counts.** A scoped drop is judged against the rule's effective severity for that
  scope — a `warn` in `src/**` under a global `error` is a drop, and pulling a scoped
  `error` back into a global `off` is a drop too.

The same-change consumption rule applies exactly as it does for `config-off`: a severity
drop on its own passes with a recorded policy change; a drop paired with new directive
debt in the same change fails the gate.

### Severity floors — when a drop is a failure

The rule above is the un-opted-in behaviour, and it is deliberate: a pure config edit
flows through your host's review, so the tool records it rather than refusing it. It does
not hold for `eslint.config.*`, which no host protects by default — so a repository that
wants its severity bands enforced in-tool declares a **floor** in
`.pocket-zipper/config.yml`:

```yaml
minSeverities:
  no-console: error    # a change that puts no-console below `error` fails: SEVERITY_FLOOR
  no-alert: warn       # error → warn is the permitted migration step; warn → off fails
```

A step down on a floored rule **fails the gate**, in `check` and in `pre-commit`, naming the
rule, the floor, the head's band and the baseline's. Nothing in the failing change
authorizes it: the floor *is* the authorization, lowered one merge earlier in a protected
policy PR that already had owner review. A rule the map doesn't name keeps today's
behaviour, so the map is also the statement of which rules are enforced. The full
treatment — the two-commit shape, grandfathering, and the deleted-declaration hole — is in
the [config reference](config-reference.md#minseverities--the-floor-is-the-authorization).

A newly declared floor cannot legalize the change that declares it: the evaluation reads
the baseline's policy, so the run it is judged under is the one before the floor existed.
And `POLICY_CHANGE` is not the floor's business to suppress — both are recorded on a
violating change, and a floor never clears the record that the change weakened governance.

## One directive can be several suppressions

A directive that names several rules expands to one logical suppression per rule:

```js
// eslint-disable-next-line no-console, no-alert
```

That is two suppressions, counted and matched independently. Adding `no-alert` to an
existing multi-rule directive creates exactly one new suppression and leaves the others
untouched.

## A bare directive names everything

`// eslint-disable-next-line` with no rule names suppresses **every rule ESLint makes
applicable** at that point — the applicable set, not the governed set. This matters twice:

- Enabling a rule in the ESLint config later starts gating bare directives that were
  already in the codebase.
- Under a `governedRules` allowlist, only applicable rules inside the allowlist carry
  debt; anything else is invisible to the lock.

## What is not gated

Some shapes never reach the inventory at all:

- **`noInlineConfig: true`** in `linterOptions` — no directives are recognized at all.
- **A multi-line `eslint-disable-line`** — ESLint refuses it; it suppresses nothing.
- **Shebang comments** (`#!...`).
- **`eslint-disable` written as a line comment** — only block comments form regions. (The
  `next-line` and `line` forms are line comments; `disable`/`enable` must be block
  comments.)
- **Legacy `.eslintrc`** — flat config only.
- **Diagnostics** — the gate counts the directive, never whether it currently fires. A
  stale suppression is still debt.

A `config-off` *is* in the inventory, but it's a policy change, not gate-failing debt —
see [`config-off`](#config-off--off-in-the-flat-config) above. A severity drop to
`"warn"` isn't in the inventory either (nothing was switched off) — it's the same kind of
recorded policy change, described under
[Severity drops](#severity-drops--a-policy-change-with-no-suppression). Both become
gate-failing under a
[severity floor](#severity-floors--when-a-drop-is-a-failure); neither is new debt, and
neither can be authorized by an exception record.

## In the report

Every flagged suppression shows its type, guard kind, and disposition — e.g.
`(next-line, directive, new)`. In a failing report, config-level entries appear in their
own section; on a pass, a recorded policy change still prints as an error line so it
isn't buried in the JSON record. See [Handling a failure](handling-a-failure.md) for how
to read the report, and [Exception record fields](handling-a-failure.md#exception-record-fields)
for which of these types an exception can authorize.