# Cleaning up unused exceptions

An exception record exists to authorize one logical suppression. When it no longer does —
the suppression was fixed, or it became existing debt — the record is **unused**, and it
stays around as signal decay: every evaluation re-reports it, the registry accumulates
records that authorize nothing, and nobody can tell at a glance whether the registry
still describes the debt that actually exists.

The honest cost of ignoring unused records is **never a blocked change** — this is
cleanup, not a gate. The cost is that the registry stops being a trustworthy map of the
authorized debt. Keeping it clean is a standing duty, named publicly here so the role is
not an accident: the **registry maintainer** owns `.pocket-zipper/` and periodically
sweeps unused records no one else cleared.

## What counts as unused

From the shared validator's vocabulary (see [the registry format](exceptions.md#defects-vs-hygiene--the-finding-vocabulary)):

- **dangling** (`DANGLING_EXCEPTION`) — no *unclaimed* suppression matching the record's
  fingerprint, type, rule, and file remains. A lookalike directive in another file never
  counts (the record's `file` scopes it), and a surplus record whose matching suppressions
  are all already covered by sibling records is dangling too.
- **spent** (`SPENT_EXCEPTION`) — its suppression has become existing (grandfathered) debt
  in the record's file and no longer needs authorization.
- **expired** (`EXPIRED_EXCEPTION`) — a temporary record past its date. Unlike the other
  shapes it authorizes nothing, so its suppression reads as unexcepted new debt — renew or
  remove.
- **overlong** (`OVERLONG_EXCEPTION`) — a temporary record whose `expires` exceeds the
  policy's `maxExpiry`. Still authorizes until its date (never a gate failure on its own),
  but a renewal that stays beyond the max fails (`EXPIRY_POLICY`).

## The basic step: fix the suppression, then delete the record

1. **Fix the code and remove the suppression** in an ordinary change. A check that also
   removes suppressions derives the records it cleared and annotates them on the report and
   pre-commit output:
   `cleared by this change — record now unused; remove it in a protected PR`.
2. **Delete the record** in a protected policy PR. Deleting a record never broadens the
   registry and never self-authorizes — it is an ordinary edit, verifiably **not** a
   `POLICY_CHANGE` — so it can: (a) ride the same change as the fix (if your repo allows
   the registry path in a code PR), (b) batch with other deletions in a cleanup PR, or
   (c) land one merge behind the fix, which is fine.

That two-part rhythm is the whole craft: a record is only safe to delete once nothing
unclaimed matches it, and the check makes that legible.

## The delete-ready pointer

On a FAIL report and in `validate` hygiene findings, a record with no unclaimed matching
suppression is printed ready to delete:

```text
entry 3 of 8 · .pocket-zipper/exceptions.yml:12-18
- rule: no-console
  suppression_type: next-line
  fingerprint: v1:sha256:6f1c…
  file: src/api.ts
  type: temporary
  reason: Console output is the intended UX for this CLI command.
  reference: "https://example.com/issues/123"
  expires: 2026-10-31
```

`entry N of M` is the record's position in the registry; the path + line range is where it
lives. Paste-as-is and delete. (Spent/expired records print at their live location instead;
dangling records print `last known: N` when the line has drifted.)

## The cleanup rollup and CI glue

On pass with `--verbose`, the report ends with a one-line greppable rollup:
`pocket-zipper-cleanup: N dangling, M spent`. It is deliberately bare — counts only, no
handles — because repo CI glue turns it into *your* notification shape. Three example
wirings, all reading the line from the CI log:

- **GitHub Actions** — a step that greps the check log for `^pocket-zipper-cleanup:` and
  posts its match as a PR comment (or annotates the run) when the counts are non-zero.
- **GitLab CI** — the same grep in a script, surfaced via an MR-level note using the
  `CI_SERVER_URL`/`CI_PROJECT_ID`/`CI_MERGE_REQUEST_IID` variables.
- **Bitbucket Pipelines** — grep the log and post to the PR using `BITBUCKET_PR_ID` and
  the quippy/pipelines API, or simply fail a low-stakes "cleanup report" step with the
  line in the log so the PR summary carries it.

None of these change the gate's verdict — they turn a maintenance signal into a review-time
reminder, the same way a coverage or dependency report does. A stricter team can make
non-zero cleanup **fail CI** (an ordinary hygiene gate, entirely their choice); the tool
itself never fails on hygiene alone.

## Who to ask: the registry maintainer and git blame

Deleting a record you wrote is unremarkable. Deleting someone else's needs a judgment
call: is the suppression really gone, or is this record mid-flight in someone's two-step
landing? When in doubt, **consult `git blame` on the record's lines** to find the human
who wrote it and ask — a practice, never an in-tool addressee (the record carries no owner
field by design; git history is the audit trail). The registry maintainer owns the sweep,
but anyone can delete a record that verifiably matches nothing.

## Why the checks point here

Both `check` and `pre-commit` end their cleanup output with a notice-line pointer to this
page, so the reader of a "dangling: 1" report knows the next step without hunting. The
wizard has **no** cleanup surface by design — removal is a registry edit judged by humans,
not an authoring flow; it lives here and in review.

## Next steps

- [Exceptions: the registry format](exceptions.md) — finding vocabulary and `validate`.
- [Landing an exception](landing-an-exception.md) — why deletions are posture-free in both
  landing modes.
- [Handling a failure](handling-a-failure.md) — reading the fail report's cleanup section.