# Handling a failure

When `pocket-zipper check` fails, the change introduces **new debt** — a suppression with
no continuous baseline counterpart, or a materially-changed one — of a governed rule that
no exception covers. You have two honest options: remove the suppression by fixing the
code, or authorize it with an exception record and get that record reviewed.

## Reading the report

A failing run looks like this (colors only on a terminal):

```text
pocket-zipper: FAIL
  existing: 3  moved-existing: 0  removed: 0  new: 1  materially-changed: 0

For this rule at this file: 2 matching records, 1 used, 1 leftover

New suppression debt requiring an exception:
  src/api.ts:42  no-console  (next-line, directive, new)
    remediate with:
    - rule: no-console
      suppression_type: next-line
      fingerprint: v1:sha256:6f1c…
      file: src/api.ts
      type: temporary
      reason: <why this suppression is necessary>
      reference: <issue or PR link>
      expires: 2026-10-31       # the concrete date your policy's defaultExpiry resolves to
      line: 42
```

- **`existing` / `moved-existing`** — the suppression was already in the baseline.
  Allowed. `moved-existing` just means its line or file changed; identity follows the
  directive, not its position, so it isn't new debt.
- **`removed`** — a baseline suppression the change deletes. Always fine.
- **`new`** — a suppression with no continuous baseline counterpart. Blocked unless
  excepted.
- **`materially-changed`** — the tomb shape: the directive text is identical to a
  baseline suppression's, but the baseline twin is dead and this one is genuinely new.
  Counted as new debt. Blocked unless excepted.
- **The per-rule count line** — `N matching records, K used, L leftover`: the pool
  bookkeeping for this rule at this file, one record per logical suppression. A leftover
  of `0` with unexcepted debt is a genuine shortfall, not a matching problem.
- **The cleanup section** — when the change removes suppressions, the records they cleared
  are annotated `cleared by this change — record now unused; remove it in a protected PR`,
  and unused records are printed `entry N of M · .pocket-zipper/exceptions.yml:lines` with
  their full text — see [Cleaning up unused exceptions](cleaning-up-unused-exceptions.md).

If the failure is instead an operational error (exit 2), no suppression is being flagged;
go to [Troubleshooting](troubleshooting.md).

## Option A — fix the code (preferred)

Remove the need for the suppression: refactor the code, change the configuration, or add
a narrowly-scoped rule override that the directive was papering over. If the directive
was already useless (it guards no emitted diagnostic), delete it. The gate only ever
counts the directive, never whether it currently fires, so a stale suppression is still
debt.

## Option B — authorize it with an exception

An **exception** is a committed record that authorizes exactly one logical suppression.
The report prints a ready-to-fill template for each offending suppression; fill in the
human fields (the machine-readable ones are prefilled). The easiest path is the
[wizard](exceptions.md#the-wizard-pocket-zipper-exception-add) — `pocket-zipper exception
add` — which is the ride-along after this very failure. Filling the record by hand works
too:

### Exception record fields

```yaml
- rule: no-console
  suppression_type: next-line     # next-line | line | block | file-level directive
  fingerprint: v1:sha256:6f1c…    # copied verbatim from the report
  file: src/api.ts                # the record's file scope
  type: temporary                 # temporary | permanent
  reason: Console output is the intended UX for this CLI command.
  reference: "https://example.com/issues/123"
  expires: 2026-10-31             # required iff type: temporary (UTC, end of day)
  # line: 42                      # optional; the wizard prefills it, drift is fine
```

- Matching is by **`fingerprint` + `suppression_type` + `rule` + `file`** — never by
  line number, so the exception survives the suppression moving around.
- `file` is the record's scope. A matching suppression in some *other* file is not
  covered: it reads as unauthorized new debt, and the record as dangling cleanup.
  Copy the value from the report rather than guessing.
- **`reason` is required; `reference` is optional** (an issue / PR / ticket link).
  `expires` is required for `temporary` and forbidden for `permanent`.
- **There is no `owner` field** — the record's author is attributed by git history, and
  cleanup accountability sits with the registry maintainer. A stale `owner:` line is a
  defect; delete it.
- `line` is optional reference data (the directive's line when the record was written).
  It drifts with the code and is never a match input — `validate` reports the drift
  (`record says 12, currently at 141`) as informational only.
- The `fingerprint` is `v1:` plus a hash of the directive's form and its normalized rule
  set. It is deliberately blind to justification, path, line, and the guarded code, so
  editing any of those doesn't invalidate the exception.
- The expiry in the template is a suggested concrete date (per your policy's
  `defaultExpiry`/`maxExpiry`); a newly written expiry beyond the `maxExpiry` is refused
  (`EXPIRY_POLICY`, exit 1). See the [config reference](config-reference.md) for the
  policy's expiry keys.

### Land the exception

Exceptions are read from the **baseline** registry — a record in the same change as the
suppression it authorizes authorizes nothing for that change (one-merge lag). How the
record lands depends on your repo's posture — two-step or combined — and on what your git
host can guarantee. That decision is the whole subject of
**[Landing an exception](landing-an-exception.md)**; in one line: *two-step* means the
record lands in a protected policy PR before the suppression PR, and *combined* is an
opt-in for GitHub / GitLab-Premium repos where the record may ride the same PR as the
suppression, additive-only and baseline-gated. Whichever posture, the registry sits behind
the same review path as the policy: human approval is where the authorization is actually
counted.

### Temporary and permanent

- **Temporary** — has an `expires` date and is valid through the end of that UTC date.
  After that it authorizes nothing and the suppression reads as unexcepted new debt.
- **Permanent** — no `expires`; intended to remain indefinitely. Permanents are
  orthogonal to `maxExpiry`.
- **Overlong** — a temporary whose `expires` exceeds the policy's `maxExpiry`. Reported
  as hygiene and still authorizes until its date; a change that *newly writes* such a date
  fails (`EXPIRY_POLICY`).

To renew a temporary exception, change its `expires` date (an in-place edit, never an
append). Renewal is a policy change and needs fresh authorization through the protected
workflow.

### Config-level suppressions are not exceptable

A rule disabled in ESLint config (`"no-console": "off"`) is a policy change, not a
directive. No exception record can authorize it. A new `config-off` is recorded on the
policy track (`POLICY_CHANGE`) and passes the gate on its own; it fails only when the
*same change* also introduces new directive debt — a weakening consumed by debt. The
config edit then goes through review like any policy edit. Lowering a governed rule to
`"warn"` (say `"error"` → `"warn"`) is the same kind of policy change, recorded the same
way — see
[Severity drops](suppression-types.md#severity-drops--a-policy-change-with-no-suppression).
The full set of shapes the gate counts — directives and config-offs — is in
[What the gate counts](suppression-types.md).

## Cleanup: unused exceptions

An exception record that authorizes nothing is **unused**. The shapes — dangling, spent,
expired, overlong — and the exact steps to remove one safely are in
**[Cleaning up unused exceptions](cleaning-up-unused-exceptions.md)**. The short version:
unused records are reported as cleanup debt and **never fail the gate on their own**;
delete a record once nothing unclaimed matches it (the report's `entry N of M · path:lines`
pointer makes that copy-paste), in a protected PR — deletion never trips `POLICY_CHANGE`.

## Next steps

- [Exceptions: the registry format](exceptions.md) — the record schema and finding
  vocabulary.
- [Landing an exception](landing-an-exception.md) — two-step vs combined.
- [Pre-commit hook](pre-commit.md) — catch this locally before pushing.
- [Troubleshooting](troubleshooting.md) — exit codes and errors.
- [Onboarding an existing codebase](onboarding-existing-codebase.md) — if you're seeing
  a wall of failures on first enable.