# Config reference

`.pocket-zipper/config.yml` is the tool's policy file, in the protected `.pocket-zipper/**`
space, separate from the exception registry. This page is the per-key reference and the
source of the canonical default.

## The canonical default

Ships as documentation, not as a scaffold: the tool never writes or scaffolds `config.yml`,
and the repo's **authorizers** land this block through a protected policy PR (the one writer
outside the protected path is onboarding itself). The canonical form spells every fallback
explicitly, so a copy-paste default pins the policy against future tool-fallback changes:

```yaml
enabled: true
# governedRules:              # optional; absent = every applicable rule is governed
exceptions:
  defaultExpiry: 30d          # duration literal (Nd / Nmo); fallback 30d
  maxExpiry: 3mo              # duration literal (Nd / Nmo); fallback 3mo
allowSameChangeExceptions: false   # fallback; host required iff this is true
```

- `governedRules` is commented out: the default is "every applicable rule governed", with
  the allowlist as the documented way to narrow.
- The `exceptions:` stanza carries the expiry policy; see below.
- `allowSameChangeExceptions` is spelled out (default `false`) so no reader guesses at the
  fall-back. `host` is documented as required **only** when the opt-in is flipped on.

An **absent** `config.yml` behaves as `enabled: true` with no allowlist, zero-config, for
reads — `check` runs against a repo that has never written one, and the two expiry keys
fall back to `30d` / `3mo`. It matters the moment someone tries to *write* an exception:
`pocket-zipper exception add` is blocked without a baseline config and hands off to the
repo's authorizers, because governance is not a mid-flow decision the wizard may make. See
[Onboarding an existing codebase](onboarding-existing-codebase.md) for landing one.

## Per-key reference

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Gate on/off. `false` → exit 0 in both modes, nothing evaluated. |
| `governedRules` | list of exact rule ids | absent = every applicable rule | Allowlist ∩ applicable set = the governed set. Globs/wildcards are out. |
| `exceptions.defaultExpiry` | duration literal | `30d` | The expiry prefilled when a temporary exception is authored (`today + defaultExpiry`). |
| `exceptions.maxExpiry` | duration literal | `3mo` | Ceiling on a newly written expiry (`EXPIRY_POLICY` refusal, exit 1). Applies to temporaries only; permanents are orthogonal. |
| `allowSameChangeExceptions` | boolean | `false` | Combined-landing opt-in: an additive record may land in the same change as the suppression it authorizes. Baseline-gated (flipping the opt-in on in the same change legalizes nothing — see [Landing an exception](landing-an-exception.md)); `host` required iff `true`. |
| `host` | enum | absent | `github` \| `gitlab-premium` \| `gitlab-free` \| `bitbucket-cloud` \| `bitbucket-server`. Repo's attestation of its host. Valid without combined (forward-declared). Combined requires a can-guarantee value (`github` / `gitlab-premium`). |

### Duration literals (`exceptions.defaultExpiry` / `maxExpiry`)

`^\d+(d|mo)$` — a positive integer plus one of two units, strict lowercase:

- `d` — exact days (`30d`).
- `mo` — calendar months, clamped to month end (May 31 + 1mo → Jun 30). A year is `12mo`
  (there is no `y` unit).

Bare integers (`30`), uppercase (`30D`), ISO durations (`P3M`) are `CONFIG_ERROR`s naming
the key and the valid forms. Absent/empty stanza or missing key → that key's fallback.

## Validation rules

Structural checks run **even when `enabled: false`** (so a typo'd key can't lie dormant
until the flip-on fails an innocent PR); only the ESLint-dependent allowlist-rule check
keeps needing the gate on. Every violation is `CONFIG_ERROR`, exit 2, naming the key:

- **Unknown keys are rejected** — at the top level and inside `exceptions:`.
- **Malformed duration literal** — one of the two valid forms, strict lowercase.
- **`defaultExpiry` > `maxExpiry`** — a self-contradicting policy.
- **Malformed YAML / `enabled` not a boolean / `governedRules` not a list of exact rule
  ids** — unchanged.
- **`governedRules` names an unrecognized ESLint rule** — fail closed (a typo can't
  silently ungovern a rule); a real rule that doesn't apply anywhere is a forward
  declaration, not an error.
- **Combined-contradiction** — `allowSameChangeExceptions: true` with `host` absent or
  outside the can-guarantee set → `CONFIG_ERROR`, forcing the repo back to two-step.

## The `allowSameChangeExceptions` + `host` pair

See [Landing an exception](landing-an-exception.md) for the full treatment. Essentials:

- **Baseline-gated.** The evaluation reads the baseline config. Flipping the opt-in on in
  the same change as a record + suppression legalizes nothing; enabling combined is itself
  a protected policy change, one merge before the first combined PR.
- **Additive only.** Identity-field edits and renewals never qualify.
- **`validate` corroborates, never guarantees.** The two hygiene findings — a host–remote
  cross-check (known domains only — `github.com` / `gitlab.com` / `bitbucket.org`; warn-only
  because custom-domain, self-hosted, mirror, and no-remote checkouts aren't classifiable,
  and the GitLab *tier* isn't in the remote) and an ownership check against the working
  tree's owners file — detect declared-vs-observed *config* mismatches. They are not gated
  the same way: `HOST_MISMATCH` fires whenever a `host` is declared, because a forward
  declaration is legal, while `OWNERS_FILE_READINESS` fires only when the opt-in is on, and
  emits one finding per protected path (the config and the registry are approved
  separately, so a repository owning only one of them has exactly the one-gap fail-open
  this exists to surface). The core never reads host or approval state.

## Migration note — unknown-key rejection (upgrade)

Unknown-key rejection is **new behavior** for the exception-flow effort. An existing
`config.yml` carrying stray keys — anything outside `enabled`, `governedRules`,
`exceptions.*`, `allowSameChangeExceptions`, `host` — now fails closed on upgrade
(`CONFIG_ERROR` naming the key) instead of being silently ignored. Fix: remove the stray
keys, or restate the config from the canonical default above; land the corrected file
through a protected policy PR. Upgrade in a controlled change; the structural checks run
even with `enabled: false`, so a dormant stray key surfaces immediately, not at first
flip-on.

## Landing the config

Every change to `.pocket-zipper/config.yml` is a protected policy change: it lands through
your host's required approvals on `.pocket-zipper/**`, takes effect from the next
evaluation's baseline (one-merge lag), and is subject to the policy-change detection in
[Handling a failure](handling-a-failure.md#config-level-suppressions-are-not-exceptable).
Onboarding an existing codebase lands it disabled first; see
[Onboarding an existing codebase](onboarding-existing-codebase.md).

## Next steps

- [Exceptions: the registry format](exceptions.md)
- [Landing an exception](landing-an-exception.md)
- [Quick start](quick-start.md)