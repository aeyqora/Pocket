# Changelog

All notable changes to `pocket-zipper` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

The **record schema** is versioned separately from the tool, by the
`schemaVersion` field in `check --json` output. A schema bump is a breaking change
for anything parsing that JSON, and is called out under its own heading.

## [Unreleased]

Nothing yet.

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
the tool's cleanup output, so they are now part of the published answer.

**Migrating.** Reading `schemaVersion: 1` output, nothing breaks. Reading v2:

- `unused` is **additive**. Existing fields keep their names, meanings, and types.
- If you branch on `schemaVersion`, accept `2` alongside `1`; a v1 reader will
  reject a v2 record rather than misread it, since the version is explicit.
- The `summary.cleanup` counts are unchanged and still the cheaper thing to
  aggregate on. `unused` is one entry per unused record, so it grows with the
  registry — prefer the counts for dashboards.

### Breaking: nothing else

No CLI flag, exit code, or gate verdict changed. `check`, `validate`, and
`exception add` take the same arguments and return the same statuses.

### Added

- **`pocket-zipper validate`** — a working-tree lint of both protected files,
  reporting registry defects and hygiene separately. Exits 0 on hygiene, 2 on
  defects.
- **Delete-ready pointers** — every unused record is now reported with the
  registry line range, its own text, and where its suppression lives, so removal
  is find-in-one-glance. The core never deletes a record.
- **Combined landing** (`allowSameChangeExceptions`) — a new *additive* exception
  record may land in the same change that consumes it, where the declared host
  guarantees path-scoped approval. Identity-field edits and renewals stay on the
  protected track.
- **Expiry lifecycle** — temporary exceptions expire, with an `EXPIRY_POLICY`
  refusal for a newly written date past the policy's maximum.
- **The authoring wizard** — `pocket-zipper exception add`, interactive or
  scripted (`--from`, `--reason`, `--reference`), including the renew branch.
- **The ride-along** — on a FAIL, the report offers to author the exception for
  the debt it just flagged.
- **`RENEWAL_BY_APPEND` hygiene** — catches a renewal that was appended rather
  than edited in place.
- **`HOST_MISMATCH` and `OWNERS_FILE_READINESS` hygiene** — corroborate a
  combined-landing declaration against the host's actual CODEOWNERS setup.

### Changed

- A change that weakens governance and adds new debt in the same change fails as
  `POLICY_CHANGE`. A pure policy edit is recorded but does not fail; that shape
  routes through host branch protection.
- Allocation is a consuming count: one record authorizes one logical suppression,
  so N same-file twins need N records and a lookalike elsewhere is unauthorized
  debt.
- A new `config-off` is recorded on the policy track, not counted as new debt, and
  no longer produces an allocation pool.
- The `line` field on an exception record is a stored pointer for readers, never
  a match input. Identity is `fingerprint + suppression_type + rule + file`.

[Unreleased]: https://github.com/aeyqora/Pocket/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/aeyqora/Pocket/compare/v0.2.0...v0.3.0
