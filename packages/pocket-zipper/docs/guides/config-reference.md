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
# minSeverities:              # optional; absent = no rule has a severity floor
#   no-console: error         # a proposed change may not put no-console below `error`
exceptions:
  defaultExpiry: 30d          # duration literal (Nd / Nmo); fallback 30d
  maxExpiry: 3mo              # duration literal (Nd / Nmo); fallback 3mo
allowSameChangeExceptions: false   # fallback; host required iff this is true
```

- `governedRules` is commented out: the default is "every applicable rule governed", with
  the allowlist as the documented way to narrow.
- `minSeverities` is commented out because the default is **no floors**: an ESLint-config
  weakening records (`POLICY_CHANGE`) and passes. Naming a rule is what makes a step-down
  of that rule a gate failure — see [the floor is the authorization](#minseverities--the-floor-is-the-authorization).
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
| `minSeverities` | map of exact rule id → `off` \| `warn` \| `error` | absent = no floors | Per-rule severity floor: the lowest band a proposed change may leave that governed rule at. Stepping below it fails the gate (`SEVERITY_FLOOR`, exit 1) — unless the band was already below the floor when the policy declared it, which is grandfathered. Absent ⇒ every step down the ladder records `POLICY_CHANGE` and passes, exactly as today. |
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
until the flip-on fails an innocent PR); only the ESLint-dependent *rule-name* checks
keep needing the gate on. Every violation is `CONFIG_ERROR`, exit 2, naming the key:

- **Unknown keys are rejected** — at the top level and inside `exceptions:`.
- **Malformed duration literal** — one of the two valid forms, strict lowercase.
- **`defaultExpiry` > `maxExpiry`** — a self-contradicting policy.
- **Malformed YAML / `enabled` not a boolean / `governedRules` not a list of exact rule
  ids** — unchanged.
- **`governedRules` names an unrecognized ESLint rule** — fail closed (a typo can't
  silently ungovern a rule); a real rule that doesn't apply anywhere is a forward
  declaration, not an error.
- **`minSeverities` is not a map of rule ids to `off` / `warn` / `error`** — malformed
  values fail closed, naming `'minSeverities.<rule>'` where the rule is identifiable and
  `'minSeverities'` otherwise.
- **`minSeverities.<rule>` names a rule `governedRules` excludes** — a floor that can
  never gate anything is refused rather than left inert (structural: the governed set is
  the allowlist ∩ applicable set, so this is knowable with no ESLint read). Add the rule to
  the allowlist or drop the floor.
- **`minSeverities.<rule>` names an unrecognized ESLint rule** — fail closed on the same
  terms as the allowlist's own check. A *real* rule whose plugin the repository has not
  installed is **not** an error: declaring a floor ahead of its plugin is legitimate
  onboarding, and it is silently ungated until the rule exists.
- **Combined-contradiction** — `allowSameChangeExceptions: true` with `host` absent or
  outside the can-guarantee set → `CONFIG_ERROR`, forcing the repo back to two-step.

The two `minSeverities` refusals are **configuration errors, not gate failures**: exit 2,
the key and the rule named, and no gate term minted — the run stops at the policy read, so
no `SEVERITY_FLOOR` or `POLICY_CHANGE` is ever raised for a floor that could not have
gated anything. A `--json` run still writes a record: a failure record carrying that one
`CONFIG_ERROR`, an empty inventory, and no verdict a gate would have produced.

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

## `minSeverities` — the floor is the authorization

`minSeverities` names, per governed rule, the lowest band a proposed change may leave that
rule at:

```yaml
minSeverities:
  no-console: error             # error → warn or error → off both fail the gate
  jsx-a11y/no-autofocus: warn   # the per-rule migration case: error → warn passes, warn → off fails
```

A change that puts a floored rule below its floor **fails the gate** (`SEVERITY_FLOOR`,
exit 1), in `check` and in `pre-commit` alike — unless the band was already below the floor
when the policy declared it, which is grandfathered. Read the failure as the sentence it
is: nothing inside the gated change authorizes it. No exception record can — a severity
drop is not exceptable — and no opt-in rides it. **The floor itself is the
authorization**, lowered one merge earlier in its own protected policy PR, in a change that
already carried owner review, and taking effect from the next evaluation. The deliberate
step-down is two commits:

```diff
  # commit 1 — .pocket-zipper/config.yml, the protected policy PR: lower the floor.
  # Raises no gate term of its own; it lands because .pocket-zipper/** needs approval.
  minSeverities:
-   no-console: error
+   no-console: warn
```

```diff
  # commit 2 — eslint.config.*, an ordinary PR: the step-down the new floor permits.
  # Passes, and still records POLICY_CHANGE: the floor removed the failure, not the fact.
  rules:
-   no-console: error
+   no-console: warn
```

That is the same one-merge lag and the same two-commit shape as `enabled` and
`governedRules`, and it is why the gate is a gate rather than a dead end. Put both commits
in one change and it fails — `POLICY_CHANGE` *and* `SEVERITY_FLOOR`, the run judged
against the floor that was in force before it. In `pre-commit` the failure says so out
loud — `staged policy floor is 'error' and takes effect from the next commit` — rather
than leaving you to work out why a floor you just wrote did nothing.

Four things the floor's judgment rests on:

- **It is a floor, not a diff.** The check reads the head against the declared floor, and
  fires when the head is below the floor **and** the change made it worse — the head band
  is below the baseline's, or the baseline declared nothing at all. That second clause is
  what keeps a floor live for a governed rule that arrived through a `...js.configs.recommended`
  spread, where there is no explicit baseline band to compare against.
- **Grandfathering.** A band already below its floor when the policy declared it stays
  green through unrelated changes; it may not be lowered further. Raise the floor to close
  the gap rather than leaving a rule ungated below the line you drew.
- **Baseline-authoritative.** A floor lowered in the same change legalizes nothing.
- **A rule the map doesn't name is ungated**, so the map is also the statement of which
  rules are enforced. Name the rules you enforce.

Floors are rule-granular and consulted whether or not the change touched a protected
file: the `.pocket-zipper` half of the policy delta has its own trigger, and a floor does
not share it. `POLICY_CHANGE` is untouched by any of this — it keeps recording that the
change weakened governance at all, on passing runs too, and a weakening consumed by new
debt in the same change still fails as `POLICY_CHANGE` whatever the floors say.

### Known limit: a deleted declaration beats the floor

Removing a rule's severity declaration outright — deleting `no-console: "warn"` from
`eslint.config.*` rather than changing it — leaves the head **undeclared** for that rule.
There is no band left to compare, so neither the floor nor the existing policy-change
detection fires, and the run goes **green**. The same hole is in today's detection, so this
is not something the floor introduced; it is something the floor cannot close.

So a floor stops a band from *moving*; it cannot see a band *disappear*. Weakening a
governed rule for real means moving it down the ladder or lowering its floor — both of
which are visible in review and in the report. If your threat model is deletion, close it
in review of `eslint.config.*` itself; see
[CI wiring principles §5](../ci/principles.md#5-the-pocket-zipper-protection-prerequisite)
for why the tool declined to own it.

## Migration note — unknown-key rejection (upgrade)

Unknown-key rejection is **new behavior** for the exception-flow effort. An existing
`config.yml` carrying stray keys — anything outside `enabled`, `governedRules`,
`minSeverities`, `exceptions.*`, `allowSameChangeExceptions`, `host` — now fails closed on
upgrade (`CONFIG_ERROR` naming the key) instead of being silently ignored. Fix: remove the
stray keys, or restate the config from the canonical default above; land the corrected file
through a protected policy PR. Upgrade in a controlled change; the structural checks run
even with `enabled: false`, so a dormant stray key surfaces immediately, not at first
flip-on.

## Landing the config

Every change to `.pocket-zipper/config.yml` is a protected policy change: it lands through
your host's required approvals on `.pocket-zipper/**`, takes effect from the next
evaluation's baseline (one-merge lag), and is subject to the policy-change detection in
[Handling a failure](handling-a-failure.md#config-level-suppressions-are-not-exceptable).
Lowering a `minSeverities` floor is the canonical example — it is the one edit whose whole
purpose is to authorize a later change, and it authorizes nothing in its own. Onboarding an
existing codebase lands the config disabled first; see
[Onboarding an existing codebase](onboarding-existing-codebase.md).

## Next steps

- [Exceptions: the registry format](exceptions.md)
- [Landing an exception](landing-an-exception.md)
- [Quick start](quick-start.md)