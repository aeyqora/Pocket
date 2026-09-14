# Handling a failure

When `pocket-lock check` fails, the change introduces **new debt** — a suppression with no
continuous baseline counterpart, or a materially-changed one — of a governed rule that no
exception covers. You have two honest options: remove the suppression by fixing the code,
or authorize it with an exception record and get that record reviewed.

## Reading the report

A failing run looks like this (colors only on a terminal):

```text
pocket-lock: FAIL
  existing: 3  moved-existing: 0  removed: 0  new: 1  materially-changed: 0

New suppression debt requiring an exception:
  src/api.ts:42  no-console  (next-line, directive, new)
    remediate with:
    - rule: no-console
      suppression_type: next-line
      fingerprint: v1:sha256:6f1c…
      file: src/api.ts
      type: temporary
      reason: <why this suppression is necessary>
      owner: <owning team>
      reference: <issue or PR link>
      expires: <YYYY-MM-DD>
```

- **`existing` / `moved-existing`** — the suppression was already in the baseline.
  Allowed. `moved-existing` just means its line or file changed; identity follows the
  directive, not its position, so it is not new debt.
- **`removed`** — a baseline suppression the change deletes. Always fine.
- **`new`** — a suppression with no continuous baseline counterpart. Blocked unless
  excepted.
- **`materially-changed`** — the tomb shape: the directive text is identical to a
  baseline suppression's, but the baseline twin is dead and this one is genuinely new.
  Counted as new debt. Blocked unless excepted.

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
human fields and add it to `.pocket-lock/exceptions.yml`.

### Exception record fields

```yaml
- rule: no-console
  suppression_type: next-line     # next-line | line | block | file-level directive
  fingerprint: v1:sha256:6f1c…    # copied verbatim from the report
  file: src/api.ts                # verification only; a mismatch fails closed
  type: temporary                 # temporary | permanent
  reason: Console output is the intended UX for this CLI command.
  owner: "@platform-team"
  reference: "https://example.com/issues/123"
  expires: 2026-10-31             # required iff type: temporary (UTC, end of day)
```

- Matching is by **`fingerprint` + `suppression_type` + `rule`** — never by line number,
  so the exception survives the suppression moving around.
- `file` is verification: if it does not match the suppression's file, the run fails
  closed. Copy it from the report rather than guessing.
- `reason`, `owner`, and `reference` are required. `expires` is required for `temporary`
  and forbidden for `permanent`.
- The `fingerprint` is `v1:` plus a hash of the directive's form and its normalized rule
  set. It is deliberately blind to justification, path, line, and the guarded code, so
  editing any of those does not invalidate the exception.

### Land the exception first (two-step landing)

Exceptions are read from the **baseline** registry. An exception committed in the same
change as the suppression it authorizes authorizes nothing for that change. Land it in
two steps:

1. A protected policy PR adding the record to `.pocket-lock/exceptions.yml`.
2. A later ordinary PR that introduces the suppression.

This is why the exception registry sits behind the same review path as the policy: human
approval is where the authorization is actually counted.

### Temporary and permanent

- **Temporary** — has an `expires` date and is valid through the end of that UTC date.
  After that it authorizes nothing and the suppression reads as unexcepted new debt.
- **Permanent** — no `expires`; intended to remain indefinitely.

To renew a temporary exception, change its `expires` date. Renewal is a policy change and
needs fresh authorization through the protected workflow.

### Config-level suppressions are not exceptable

A rule disabled in ESLint config (`"no-console": "off"`) is a policy change, not a
directive. It is reported on the policy track and cannot be authorized by an exception
record. Change the config through the protected policy workflow instead.

## Cleanup: unused exceptions

An exception record that authorizes nothing is **unused**. Two shapes:

- **dangling** — its suppression no longer exists anywhere.
- **spent** — its suppression has become existing debt (it landed in the baseline), so
  the record is no longer doing work.
- **expired** — a temporary exception past its date. Unlike the other two, an expired
  record does not authorize, so its suppression counts as unexcepted new debt.

Unused exceptions are reported as cleanup debt and **never fail the gate on their own**.
Delete dangling and spent records when you notice them. Expired records should either be
renewed or the suppression removed.

## Next steps

- [Pre-commit hook](pre-commit.md) — catch this locally before pushing.
- [Troubleshooting](troubleshooting.md) — exit codes and errors.
- [Onboarding an existing codebase](onboarding-existing-codebase.md) — if you are seeing
  a wall of failures on first enable.
