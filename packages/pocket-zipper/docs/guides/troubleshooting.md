# Troubleshooting

## Exit codes

| Exit | Verdict | Meaning |
| --- | --- | --- |
| `0` | pass | Nothing unauthorized. Also used when the policy is `enabled: false` (the record verdict is `excluded`), and for hygiene-only `validate` findings. |
| `1` | fail | Unauthorized new or materially-changed debt of a governed rule; a policy-weakening edit consumed by new debt (`POLICY_CHANGE`); a floored rule stepped below its `minSeverities` band (`SEVERITY_FLOOR`); or a newly written expiry beyond the baseline max (`EXPIRY_POLICY`). |
| `2` | fail closed | An operational error: `GIT_ERROR`, `ESLINT_ERROR`, `CONFIG_ERROR`, or `INTERNAL_ERROR`; or a registry/config defect surfaced by `validate`. Nothing was approved. |

Granular reasons live in the evaluation record's `errors[]`, not in the exit code.

A rule turned `"off"` in `eslint.config.*` — or lowered to `"warn"` — is a policy change,
not debt: it records as `POLICY_CHANGE` and exits `0` on its own, and exits `1` only when
the same change also adds new directive debt, or when a `minSeverities` floor covers the
rule (`SEVERITY_FLOOR`). See [What the gate counts](suppression-types.md).

## Error codes

| Code | Typical cause | Fix |
| --- | --- | --- |
| `GIT_ERROR` | Not a git repository; a shallow clone that cannot unshallow; a partial (promisor) clone; an unresolvable `--base`; no merge-base; pre-commit in a bare repo. | See [Git problems](#git-problems). |
| `CONFIG_ERROR` | Malformed or invalid `.pocket-zipper/config.yml` or `.pocket-zipper/exceptions.yml` — including any config key outside the known set (unknown-key rejection) — or an unrecognized rule in `governedRules`, or a `minSeverities` floor that could never gate anything. | See [Config problems](#config-problems) and the [config reference](config-reference.md). |
| `EXPIRY_POLICY` | A record's newly written `expires` exceeds the baseline `maxExpiry` — a new record or a renewal. Exit 1; the one pure-policy shape the core refuses. | Bump `maxExpiry` in its own protected PR first, then write the record; or shorten the expiry; permanents are unaffected. |
| `SEVERITY_FLOOR` | A proposed change left a governed rule below the band `minSeverities` declares for it — `error` → `warn`, `error` → `off`, or `warn` → `off` on a rule floored at `error`. Exit 1, and no exception record can cover it. | Lower the floor in its own protected policy PR; it takes effect from the next evaluation, so the step-down lands as a second commit. See [the floor is the authorization](config-reference.md#minseverities--the-floor-is-the-authorization). |
| `ESLINT_ERROR` | ESLint acknowledged a suppression Pocket Zipper did not inventory. Fail-closed safety net. | Report it as a bug with the printed file and rule. |
| `INTERNAL_ERROR` | An unexpected failure. | Re-run with `--json` and inspect `errors[]`. |

## Git problems

### "shallow repository and could not unshallow"

Pocket Zipper needs full history to resolve the baseline. It detects a shallow clone and
tries `git fetch --unshallow` automatically; if that fails (offline, no network), it
fails closed. In CI, configure a full clone: GitHub's `fetch-depth: 0`, GitLab's
`GIT_DEPTH: 0`, or an explicit fetch of the target ref on Bitbucket. See
[CI wiring principles §1](../ci/principles.md#1-a-full-depth-clone-is-mandatory).

### "partial (promisor) clone detected"

Promisor clones serve objects on demand and can't guarantee the baseline is fully present.
Pocket Zipper fails closed. Use a regular full clone.

### "cannot resolve ref '…' to a commit"

The ref you passed to `--base` isn't in the local clone. CI clones often fetch only the
refs the checkout needs. Fetch the target branch first:

```sh
git fetch origin "<target-branch>"
npx pocket-zipper check --base "origin/<target-branch>"
```

Each host's [CI guide](ci/github.md) spells the exact variable and fetch.

### "no merge-base between the target ref and HEAD"

The target and `HEAD` share no history — unrelated branches, or a rewritten history. Pass
a pinned base SHA supplied by the host instead of a branch name.

## Config problems

### `enabled` must be a boolean

`enabled` is `true` or `false`, not a string. An absent config file is allowed and means
enabled with no allowlist.

### "governedRules names an unrecognized ESLint rule"

The rule id is misspelled, or the plugin that provides it isn't installed and configured.
This is a hard error (fail closed) so a typo can't silently ungovern a rule. A real rule
that doesn't currently apply anywhere is *not* an error — it's a forward declaration.

### "'minSeverities.X' names rule 'X', which 'governedRules' excludes"

A floor for a rule outside the allowlist could never gate anything, so it is refused rather
than left inert: the governed set is the allowlist ∩ applicable set, and a rule the
allowlist drops is never governed. This and the refusal below are `CONFIG_ERROR`, exit 2,
naming the key and the rule — not gate failures. Fix: add the rule to `governedRules`, or
drop the floor. Land the corrected config through a protected policy PR.

### "'minSeverities.X' names an unrecognized ESLint rule 'X'"

Same fail-closed reasoning as the allowlist's own check — a typo must not leave a floor
sitting there that gates nothing. A **real** rule whose plugin the repository has not
installed is not an error: declaring a floor ahead of the plugin is legitimate onboarding,
and it is silently ungated until the rule exists.

### Exception record errors

`.pocket-zipper/exceptions.yml` must be a top-level list of records. The known fields are
`rule`, `suppression_type`, `fingerprint`, `file`, `type`, `reason`, `reference`,
`expires`, and `line` — see the [registry format](exceptions.md#record-format) for which
are required and which optional. Things that **fail closed** (`CONFIG_ERROR`, exit 2) with
a precise diagnostic (entry index, field, expected vs actual, line/column):

- a record outside the known field set — **unknown fields are rejected** (this includes a
  stale `owner:`, which reads `unknown field 'owner' — removed from the registry format;
  delete this line`);
- missing/invalid `rule` / `suppression_type` / `fingerprint` / `file` / `type` / `reason`
  (or `expires` on a `permanent`);
- a malformed fingerprint (must match `v1:sha256:` + 64 hex chars);
- a calendar-invalid date like `2026-13-45` (real calendar validity, not just regex);
- malformed YAML or a non-list shape (including the copy/paste class: entries accidentally
  nested under a top-level `exceptions:` header).

A record whose `file` differs from the suppression's location authorizes **nothing** — the
suppression reads as unauthorized new debt (exit 1, not a config failure) and the record as
dangling cleanup. A record naming an *unknown rule id* is hygiene, not a defect. Run
`pocket-zipper validate` to see every finding in one pass — defects exit 2, hygiene alone
exits 0. See [the registry format](exceptions.md) and
[What the gate counts](suppression-types.md) for the shapes behind these types.

## Severity floors

### "rule 'X' is below severity floor 'Y': head is 'Z', baseline is 'W'"

`SEVERITY_FLOOR`, exit 1 — the change stepped a floored rule down the `off → warn → error`
ladder. No exception record can cover it; the floor is the authorization, so lower the
floor in its own protected policy PR and land the step-down as a second commit. The
message carries the four facts a run needs — the rule, the floor, the head's band, the
baseline's — in the report and in the record's `errors[].detail`. `pre-commit` adds the
staged floor and when it takes effect.

The commonest cause is **lowering the floor in the same change**: the evaluation reads the
baseline's policy, so the run is judged against the floor that was in force before it, and
the floor you just wrote buys nothing. A baseline of `undeclared` means the rule arrived
through a preset spread (`...js.configs.recommended`) that carries no explicit band to
compare against — exactly the case a diff-only check would miss.

### The floor I set, and the step-down still passed

The floor is read against the head, but the *change* is what has to make it worse. Two
shapes explain a green run:

- **The band was already below the floor.** A band below the line when the policy declared
  it is grandfathered: it may stay, and lowering it further fails. Raise the floor to close
  the gap.
- **The declaration was deleted rather than lowered.** Removing `no-console: "warn"` from
  `eslint.config.*` leaves the head undeclared for that rule, so there is no band left to
  compare and neither the floor nor the existing policy-change detection fires. A floor
  stops a band from moving; it cannot see one disappear. See the
  [known limit](config-reference.md#known-limit-a-deleted-declaration-beats-the-floor).

A rule the map doesn't name is ungated entirely, so a floor that never fires may just be a
rule the map never reached.

## Why is nothing being evaluated?

- **`enabled: false`** — the check exits 0 with verdict `excluded` and validates nothing.
- **An allowlist excludes the rule** — only rules in `governedRules` that ESLint makes
  applicable are counted. Everything else is invisible.
- **The path is skipped** — Pocket Zipper ignores `.git/`, `node_modules/`, and
  `.pocket-zipper/` itself, and skips binary files.
- **A stale suppression guards no current diagnostic** — it is still counted. Debt is
  the directive, not the emitted diagnostic.

## Everything is new debt right after enabling

You enabled the gate cold on a repository with existing suppressions, so none of them
have a baseline counterpart. Grandfather them instead of writing exceptions: follow
[Onboarding an existing codebase](onboarding-existing-codebase.md).

## Requirements

- **Node.js** 20 or newer.
- **ESLint** 9 or newer (flat config only), installed and configured in the repository. It
  is the semantic authority for which rules apply where.
- **git** 2.43 or newer, with a full clone. Rename detection (`-M`) and NUL-delimited
  output (`-z`) are spelled explicitly. No `user.name`/`user.email` is required.
- `check`, `pre-commit`, and `validate` never write to your working tree except the file
  you point `--json` at. The one exception is the authoring wizard,
  `pocket-zipper exception add`, which appends the records it proposed to
  `.pocket-zipper/exceptions.yml` — a proposal to your working tree that still has to land
  through review.

## The evaluation record

`check --json <path>` writes a versioned record (`schemaVersion: 3`) carrying both
compared tree ids, the applied policy, per-suppression dispositions, exception matches,
the delete-ready pointers for every unused record, and granular errors. CI should persist
it on failure as well as success — that's the durable statistics artifact. See
[CI wiring principles §4](../ci/principles.md#4-the-evaluation-record-is-the-statistics-artifact).

`schemaVersion: 2` added the `unused` array; `3` adds `summary.policy.minSeverities`, the
effective floor map (`null` when no map is declared). It is what lets a machine tell
"recorded, not gated" from "gated and satisfied": the same config weakening is a passing
`POLICY_CHANGE` with `minSeverities: null`, and a failing `SEVERITY_FLOOR` once the rule
is floored. A `SEVERITY_FLOOR` error also carries a `detail` of
`{ rule, floor, head, baseline }`. See the changelog for the migration note.

## Protecting the policy

Worried an author can weaken the gate and approve their own debt in one change? That's
the `.pocket-zipper/**` protection prerequisite — a required check plus path-gated review
on `.pocket-zipper/**`. See
[CI wiring principles §5](../ci/principles.md#5-the-pocket-zipper-protection-prerequisite)
and your host's [CI guide](ci/github.md).

## Still stuck?

Re-run with `--json <path>` and inspect `errors[]` in the record for the granular cause.
The record and the exact command you ran are the two things a maintainer needs to help.