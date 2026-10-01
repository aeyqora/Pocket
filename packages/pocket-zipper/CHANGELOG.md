# Changelog

All notable changes to `pocket-zipper` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

The **record schema** is versioned separately from the tool, by the
`schemaVersion` field in `check --json` output. A schema bump is a breaking change
for anything parsing that JSON, and is called out under its own heading.

This changelog starts at 0.2.0. Releases before that predate it.

## [Unreleased]

### Breaking: record schema 2 → 3

`check --json` now writes `schemaVersion: 3`, which adds one field and one error code:

```jsonc
{
  "schemaVersion": 3,
  "summary": {
    "policy": {
      "enabled": true,
      "allowlist": null,
      "minSeverities": { "no-console": "error" }   // new: the effective floor map
    }
  },
  "errors": [
    {
      "code": "SEVERITY_FLOOR",                    // new code
      "message": "rule 'no-console' is below severity floor 'error': head is 'warn', baseline is 'error'",
      "detail": { "rule": "no-console", "floor": "error", "head": "warn", "baseline": "error" }
    }
  ]
}
```

**Why.** A config weakening has always been *recorded* rather than gate-failed, because
the tool's protection stops at `.pocket-zipper/**` and `eslint.config.*` has no equivalent
on any host by default. The new opt-in closes that gap from the policy side, and a machine
reading the record has to be able to tell the two situations apart: a weakening that was
recorded and passed, and a weakening that was gated and satisfied. `minSeverities` is the
only place that difference is legible. Each `SEVERITY_FLOOR` error carries four facts in
`detail` — `rule`, `floor` (the declared minimum), `head` (the band the change left), and
`baseline` (the band it replaced, or `"undeclared"` when the rule arrived through a preset
spread).

**Migrating.** Reading `schemaVersion: 2` output, nothing breaks. Reading v3:

- `summary.policy.minSeverities` is **additive**: `null` when no map is declared, the
  effective map otherwise. Existing fields keep their names, meanings, and types, so a v3
  consumer is a superset of a v2 one.
- `SEVERITY_FLOOR` is a **new code** in `errors[]`. A consumer branching on codes should
  treat it as a gate failure; with no map declared it never appears, and `verdict: "pass"`
  carrying a `POLICY_CHANGE` stays representable — with the default off, that is the common
  case, not a corner case.
- If you branch on `schemaVersion`, accept `3` alongside `2` and `1`. Older readers reject
  a newer record rather than misreading it, since the version is explicit.

### Added

- A narrow repair path for a defective baseline exception registry. A change carrying a
  defect-free replacement is evaluated with empty baseline coverage, reports the
  baseline findings as `BASELINE_DEFECT`, and remains unable to authorize its own debt.
- **Severity floors** (`minSeverities`) — an opt-in, per-rule map in
  `.pocket-zipper/config.yml` naming the lowest band a proposed change may leave a
  governed rule at. A step down on a floored rule fails the gate (`SEVERITY_FLOOR`, exit 1)
  in `check` and `pre-commit` alike. **The floor is the authorization:** nothing inside the
  gated change authorizes it, so a floor is lowered one merge earlier, in a protected policy
  PR that already carries owner review, and takes effect from the next evaluation — the
  same one-merge lag as `enabled` and `governedRules`.
- A floor is read against the head rather than diffed against the baseline, so a governed
  rule enabled only by a `...js.configs.recommended` spread is still covered; a band
  already below its floor when the policy declared it is grandfathered and may not be
  lowered further.
- **Inert floors fail closed** — `CONFIG_ERROR` (exit 2, not a gate failure) for a floor
  naming a rule the `governedRules` allowlist excludes, and for a rule id no ESLint rule
  matches. A floor for a *real* rule from a plugin the repository has not installed is
  accepted and silently ungated, so declaring a floor ahead of its plugin is legitimate
  onboarding.

### Known limits

- **Deleting a severity declaration beats the floor.** Remove a rule's declaration from
  `eslint.config.*` rather than lowering it and the head is undeclared for that rule: no
  band exists to compare, so neither the floor nor the existing policy-change detection
  fires. This hole predates the floor; closing it needs ESLint's resolved-per-file
  configuration.
- **Per-scope floors.** Floors are rule-granular. A scoped floor multiplies the config
  surface by pattern, and nobody maintains it.

## [0.3.0] — 2026-09-29

The exception-flow build, plus a round of module deepening.

### Breaking: record schema 1 → 2

`check --json` now writes `schemaVersion: 2`, which adds one field:

```jsonc
{
  "schemaVersion": 2,
  "summary": { "cleanup": { "danglingExceptions": 2 } },  // unchanged: the counts
  "unused": [                                             // new
    {
      "status": "dangling",
      "entry": 1,
      "entries": 3,
      "registryLines": { "start": 2, "end": 9 },
      "text": "- rule: no-console\n  ...",
      "live": null,
      "recorded": 7,
      "clearedByThisChange": false
    }
  ]
}
```

**Why.** In v1 the record published the cleanup *counts* and kept the delete-ready
pointers in the human report alone, on the argument that the addresses are for a
person reading a report rather than for a statistics artifact. That held for the
report and not for the JSON: a consumer holding a v1 record could learn that two
records were dangling and could not learn which two. The pointers are the whole of
the tool's cleanup output, and the core never deletes a record, so they are the only
route from "this record authorizes nothing" to "cut these lines".

**Migrating.** Reading `schemaVersion: 1` output, nothing breaks. Reading v2:

- `unused` is **additive**. Existing fields keep their names, meanings, and types,
  so a v2 consumer is a superset of a v1 one.
- If you branch on `schemaVersion`, accept `2` alongside `1`. A v1 reader rejects a
  v2 record rather than misreading it, since the version is explicit.
- The `summary.cleanup` counts are unchanged and remain the cheaper thing to
  aggregate on. `unused` is one entry per unused record, so it grows with the
  registry — prefer the counts for dashboards.

### Breaking: nothing else

No CLI flag, exit code, or gate verdict changed. `check`, `validate`, and
`exception add` take the same arguments and return the same statuses.

### Added

- **`pocket-zipper validate`** — a working-tree lint of both protected files,
  reporting registry defects and hygiene separately. Exits 0 on hygiene, 2 on
  defects.
- **Delete-ready pointers** — every unused record is now reported with the registry
  line range, its own text, and where its suppression lives, so removal is
  find-in-one-glance. The core never deletes a record.
- **Combined landing** (`allowSameChangeExceptions`) — a new *additive* exception
  record may land in the same change that consumes it, where the declared host
  guarantees path-scoped approval. Identity-field edits and renewals stay on the
  protected track.
- **Expiry lifecycle** — temporary exceptions expire; a newly written date past the
  policy's maximum is refused as `EXPIRY_POLICY`.
- **The authoring wizard** — `pocket-zipper exception add`, interactive or scripted
  (`--from`, `--reason`, `--reference`), including the renew branch.
- **The ride-along** — on a FAIL, the report offers to author the exception for the
  debt it just flagged.
- **`HOST_MISMATCH` and `OWNERS_FILE_READINESS` hygiene** — corroborate a
  combined-landing declaration against the host's actual CODEOWNERS setup.

### Changed

- A change that weakens the `.pocket-zipper` policy and adds new debt in the same
  change fails as `POLICY_CHANGE`. A pure policy edit is recorded but does not
  fail; that shape routes through host branch protection. (ESLint-config
  severities joined this behaviour in 0.2.0.)
- A new `config-off` is recorded on the policy track rather than counted as new
  debt, and no longer produces an allocation pool.
- Allocation is a consuming count: one record authorizes one logical suppression,
  so N same-file twins need N records and a lookalike elsewhere is unauthorized
  debt.
- A record's `line` is a stored pointer for readers, never a match input. A record
  matches on `fingerprint + suppression_type + rule`, narrowed by its `file` scope.

## [0.2.0]

### Added

- **A config-level severity weakening is a policy change, not debt.** Lowering a
  governed rule's severity in `eslint.config.*` — a new `off`, or a drop from
  `error` to `warn` — records a `POLICY_CHANGE` instead of reading as new debt. It
  fails the gate on its own only when the same change consumes the weakening with
  new directive debt, mirroring `.pocket-zipper` allowlist narrowing.
- A recorded policy change is surfaced on a **pass** in the human report, not only
  in the JSON record.

### Notes

- A `warn` rule stays live, so its directives are still gated. Unlike an `off`, a
  severity drop to `warn` never hides debt.
- Strengthenings record nothing.

[Unreleased]: https://github.com/aeyqora/Pocket/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/aeyqora/Pocket/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/aeyqora/Pocket/compare/v0.1.0...v0.2.0
