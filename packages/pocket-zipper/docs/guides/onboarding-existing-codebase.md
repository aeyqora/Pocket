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

Add `.pocket-zipper/config.yml` with the gate off:

```yaml
enabled: false
```

Land this through your **protected policy PR** — the same review path that will later
guard exceptions. See [Protecting the policy](#protecting-the-policy) below and
[CI wiring principles §5](../ci/principles.md#5-the-pocket-zipper-protection-prerequisite).

While `enabled: false`, Pocket Zipper evaluates nothing, exits 0, and skips policy
validation entirely.

## Step 2 — mass-suppress in ordinary PRs

With the gate off there is no pressure. Add the ESLint suppression directives you want
the codebase to carry, or run whatever bulk-suppression tooling you prefer, in ordinary
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

Two facts keep this safe:

- **Narrowing a policy is recorded but not gate-failed on its own.** Adding a
  `governedRules` allowlist that excludes rules is a policy-change signal. If the *same
  change* also introduces new debt under the old, broader policy, it fails
  (`POLICY_CHANGE`, exit 1); a pure policy edit is recorded and lands through review.
- **Baseline-authoritative means one merge of lag.** A head-side config edit never
  shapes its own evaluation. Widen the allowlist in this change; its effect is felt from
  the next one. This is deliberate — it stops a change from rewriting the policy and
  consuming the result in the same breath.

`governedRules` entries must be rules ESLint recognizes. An unrecognized id fails closed
(`CONFIG_ERROR`, exit 2). A recognized rule that does not currently apply anywhere is a
forward declaration and is fine.

## Protecting the policy

`.pocket-zipper/config.yml` and `.pocket-zipper/exceptions.yml` are the policy surface: one
shapes what debt exists, the other authorizes new debt. Keep both mergeable only through
approved policy pull requests (required reviewers or CODEOWNERS on `.pocket-zipper/**`) and
protect the code-owners file itself. Without that protection an author could weaken the
gate and approve their own debt in one change — the exception registry would be
toothless. The per-host
[CI guides](ci/github.md) and [principles §5](../ci/principles.md#5-the-pocket-zipper-protection-prerequisite)
cover the wiring.

## Next steps

- [Handling a failure](handling-a-failure.md) — what to do when a later change trips the gate.
- [CI quick-starts](ci/github.md) — put the authoritative check in your pipeline.
- [Quick start](quick-start.md) — the command surface if you skipped it.
