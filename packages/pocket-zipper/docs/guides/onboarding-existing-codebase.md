# Onboarding an existing codebase

Enabling Pocket Zipper on a repository that already has ESLint suppressions would flag
every one of them as new debt and block the first change. Grandfather them instead: land
the policy switched off, add the suppressions you need, then flip the gate on. The
suppressions that already exist become **existing debt** and are allowed to remain.

The whole flow leans on one rule: **the effective policy is always the baseline's.** A
change is evaluated under the policy as it existed *before* the change, so a config edit
takes effect from the next evaluation, and the flip itself is judged under the old
(disabled) policy.

## Step 1 — land the policy disabled

Add `.pocket-zipper/config.yml` with the gate off. The canonical default from the
[config reference](config-reference.md) is the copy-paste source — land it with
`enabled: false` on the first pass (the only deliberate deviation; the canonical form
ships `enabled: true`, and step 3 restores it):

```yaml
enabled: false                      # the canonical default ships enabled: true; this first landing disables the gate
# governedRules:                    # optional; absent = every applicable rule is governed
exceptions:
  defaultExpiry: 30d                # duration literal (Nd / Nmo); fallback 30d
  maxExpiry: 3mo                    # duration literal (Nd / Nmo); fallback 3mo
allowSameChangeExceptions: false    # fallback; host required iff this is true
```

Land this through your **protected policy PR** — the same review path that will later
guard exceptions. See [Protecting the policy](#protecting-the-policy) below and
[CI wiring principles §5](../ci/principles.md#5-the-pocket-zipper-protection-prerequisite).

While `enabled: false`, Pocket Zipper evaluates nothing, exits 0, and skips policy
validation entirely (structural config checks still run — a typo'd key during onboarding
fails fast instead of lying dormant until flip-on, per the config reference's validation
rules).

## Step 2 — mass-suppress in ordinary PRs

With the gate off there's no pressure. Add the ESLint suppression directives you want the
codebase to carry — or run whatever bulk-suppression tooling you prefer — in ordinary
pull requests. Prefer per-line directives (`// eslint-disable-next-line`) over broad
file-level ones so the debt stays visible and local.

Nothing is counted yet. This step just gets the suppressions into the baseline.

## Step 3 — flip the gate on

Change the config to:

```yaml
enabled: true
```

Land this in a **protected policy PR** too. This change is itself evaluated under the
baseline's (still disabled) policy, so it passes, and from the next evaluation onward
every suppression already in the tree is **existing debt**. Existing debt is never
blocked; only new or materially-changed debt is.

## Step 4 — narrow, then widen

With the toggle flipped, everything applicable is governed. Teams usually start narrower
and onboard rules a few at a time:

```yaml
enabled: true
governedRules:
  - no-console
```

Change the allowlist in protected policy PRs. To widen later, add rule ids:

```yaml
enabled: true
governedRules:
  - no-console
  - jsx-a11y/no-autofocus
```

Four facts keep this safe:

- **Narrowing a policy is recorded but not gate-failed on its own.** Adding a
  `governedRules` allowlist that excludes rules is a policy-change signal. If the *same
  change* also introduces new debt under the old, broader policy, it fails
  (`POLICY_CHANGE`, exit 1); a pure policy edit is recorded and lands through review.
- **Turning a rule `"off"` in `eslint.config.*` is the same kind of policy change.** A
  new `config-off` is recorded (`POLICY_CHANGE`) and passes on its own; consumed by new
  directive debt in the same change, it fails the gate. It is never exceptable.
- **Lowering a rule to `"warn"` counts too.** `"error"` → `"warn"` (and every step down
  the off → warn → error ladder) is a recorded policy change, even though the rule still
  runs. Same rule: pure edit passes and is recorded; paired with new debt it fails. See
  [Severity drops](suppression-types.md#severity-drops--a-policy-change-with-no-suppression).
- **Baseline-authoritative means one merge of lag.** A head-side config edit never shapes
  its own evaluation. Widen the allowlist in this change; its effect is felt from the
  next one. This is deliberate — it stops a change from rewriting the policy and
  consuming the result in the same breath.

`governedRules` entries must be rules ESLint recognizes. An unrecognized id fails closed
(`CONFIG_ERROR`, exit 2). A recognized rule that doesn't currently apply anywhere is a
forward declaration and is fine.

## Protecting the policy

`.pocket-zipper/config.yml` and `.pocket-zipper/exceptions.yml` are the policy surface:
one shapes what debt exists, the other authorizes new debt. Keep both mergeable only
through approved policy pull requests (required reviewers or CODEOWNERS on
`.pocket-zipper/**`), and protect the code-owners file itself. Without that protection an
author could weaken the gate and approve their own debt in one change — the exception
registry would be toothless. The per-host
[CI guides](ci/github.md) and [principles §5](../ci/principles.md#5-the-pocket-zipper-protection-prerequisite)
cover the wiring.

## Next steps

- [Handling a failure](handling-a-failure.md) — what to do when a later change trips the gate.
- [Exceptions: the registry format](exceptions.md) — the exception flow once you're live.
- [Config reference](config-reference.md) — the canonical default and every config key.
- [CI quick-starts](ci/github.md) — put the authoritative check in your pipeline.
- [Quick start](quick-start.md) — the command surface if you skipped it.