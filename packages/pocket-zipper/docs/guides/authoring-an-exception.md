# Authoring an exception

`pocket-zipper exception add` is how an exception record gets written. It is a guided
ride: it works out the match fields for you, asks only for what a human actually knows —
a reason, a reference, and a date — checks its own answer, and writes a **proposed** record
to your working tree. It is never the step that authorizes anything; that is still your
repo's protected review.

This page is the operator's guide to the flow. The record's fields and the finding
vocabulary are in [the registry format](exceptions.md); where the record then has to go
is in [Landing an exception](landing-an-exception.md).

Every transcript below is verbatim tool output. The dates are the day the transcript was
captured — they resolve against the day you run it.

## The two front doors

One engine, two entries.

**The ride-along.** When a local `pocket-zipper check` fails, the report is followed by
`create an exception for this debt? [y/N]` — the failing suppressions are already
selected, so there is no session choice and nothing to re-identify. Answer `y` and the
interview starts; press Enter and you are back to your shell with the report and nothing
written.

The offer is made only where someone can answer it: on a terminal, and never on a
`--json` run, whose output belongs to whatever reads the record. In CI it simply does not
appear, and the `exception add` command is the door there.

**The dedicated command.** Run it deliberately, with or without a failing change:

```sh
pocket-zipper exception add
```

It recomputes the working tree's new debt with the same engine `check` reads with, and
opens a session choice.

Both are shown in full below.

## The command line

| Flag | Meaning |
|---|---|
| `--from <file>:<line>` | Selects the suppression to record instead of prompting, and switches the whole session to non-interactive. |
| `--reason <text>` | The interview's required answer. |
| `--reference <link>` | The interview's optional answer. Omit it and the record carries no `reference`. |

`--reason` and `--reference` only travel with `--from`; on their own they are a usage
error. There are no other flags — `exception add` takes no `--base`, no `--json`, no
`--verbose`, and an unknown flag is refused rather than ignored.

### Non-interactive

With `--from`, the interview is answered by flags and the expiry prefills from the policy
default. No prompts, no way to be prompted:

```sh
$ pocket-zipper exception add --from app.js:2 \
    --reason "Needed for the debug toolbar." \
    --reference "https://github.com/org/repo/issues/123"
Review — the record(s) to write:
  • no-console @ app.js:2 — next-line (new) — expires 2026-10-29
    reason:    Needed for the debug toolbar.
    reference: https://github.com/org/repo/issues/123
✎ exception record written to .pocket-zipper/exceptions.yml
it takes effect only once the change is approved and merged.

Next steps
  1. land the record in its own PR — an approver reviews and merges it
  2. once merged, land the code change that adds the suppression
```

**`--from` is a position, not an identity, and it must be unambiguous.** It takes
`file:line`, and it needs the line of the *directive*. A line carrying a multi-rule
directive is two logical suppressions, and the flag cannot choose between them:

```text
$ pocket-zipper exception add --from app.js:2 --reason "x"
2 suppressions sit at app.js:2 — --from cannot choose between them; record them in an interactive session
```

Use the interactive session for that one. A malformed selector is refused too:

```text
$ pocket-zipper exception add --from app.js --reason "x"
--from expects <file>:<line> — got 'app.js'
```

## Exit codes

`exception add` is not a gate, so its codes mean something different from `check`'s. The
one that matters most: **the ride-along does not change `check`'s verdict.** A run that
FAILs and then authors a record still exits 1 — authoring is not the change that
authorizes.

| Exit | Meaning |
|---|---|
| `0` | The session finished: a record was written, the write was declined, or there was nothing to do. |
| `1` | Refused or blocked: no config at the baseline, no debt at `--from`, an ambiguous or malformed `--from`, a missing `--reason`, a date the expiry policy refused, or input that ran out before a session reached its write prompt. |
| `2` | Usage error, or the working tree could not be read — a bare checkout, a registry this session cannot read, an internal error. |

## A whole session, new debt

The dedicated command, one suppression, the default expiry accepted. Typed answers echo
as `❯ answer`; an accepted default echoes only the value it resolved to.

```text
$ pocket-zipper exception add
reading the working tree's new debt…
this session is for:
  1) new debt from this change
  2) renew an expiring record
choose — 1 (new debt) or 2 (renew):
❯ 1
→ new debt
  1) app.js:2  no-console  (next-line, new)
select which to record (number — 1):
❯ 1
◉ selected  app.js:2  no-console  (next-line)
reason for the exception (required):
❯ Needed for the debug toolbar.
reference (issue / PR / ticket link) — optional; Enter to skip:
reference (issue / PR / ticket link) — optional: Skipped
a default expiry of 2026-10-29 (30 days from today) is set — accept it? [Y/n]
expiry: 2026-10-29
Review — the record(s) to write:
  • no-console @ app.js:2 — next-line (new) — expires 2026-10-29
    reason:    Needed for the debug toolbar.
write the exception? [y/N]
❯ y
✎ exception record written to .pocket-zipper/exceptions.yml
it takes effect only once the change is approved and merged.

Next steps
  1. land the record in its own PR — an approver reviews and merges it
  2. once merged, land the code change that adds the suppression
run another session? [y/N]
```

The ride-along is the same session with the failure report in front of it and no session
choice:

```text
pocket-zipper: FAIL
  existing: 0  moved-existing: 0  removed: 0  new: 1  materially-changed: 0

For this rule at this file: 0 matching records, 0 used, 0 leftover

New suppression debt requiring an exception:
  app.js:2  no-console  (next-line, directive, new)
    remediate with:
    - rule: no-console
      suppression_type: next-line
      fingerprint: v1:sha256:aa3906bd4b359e41c41625a924d3d3bbe95138e721f89cd87cd38839056a0f3e
      file: app.js
      type: temporary
      reason: <why this suppression is necessary>
      reference: <issue or PR link>
      expires: 2026-10-29
      line: 2
◉ selected  app.js:2  no-console  (next-line)
create an exception for this debt? [y/N]
❯ y
reason for the exception (required):
❯ Needed for the debug toolbar.
reference (issue / PR / ticket link) — optional; Enter to skip:
❯ https://github.com/org/repo/issues/123
a default expiry of 2026-10-29 (30 days from today) is set — accept it? [Y/n]
expiry: 2026-10-29
Review — the record(s) to write:
  • no-console @ app.js:2 — next-line (new) — expires 2026-10-29
    reason:    Needed for the debug toolbar.
    reference: https://github.com/org/repo/issues/123
write the exception? [y/N]
❯ y
✎ exception record written to .pocket-zipper/exceptions.yml
it takes effect only once the change is approved and merged.

Next steps
  1. land the record in its own PR — an approver reviews and merges it
  2. once merged, land the code change that adds the suppression
run another session? [y/N]
```

Four things to read off that. The reason is **required** — Enter is not a way past it:

```text
reason for the exception (required):
the reason is required — type it (Enter has no meaning here)
reason for the exception (required):
```

A skipped reference is recorded as a skip, and the record simply omits the field. The
`Review` block is the record **as it will read** — what is written is:

```yaml
- rule: no-console
  suppression_type: next-line
  fingerprint: v1:sha256:aa3906bd4b359e41c41625a924d3d3bbe95138e721f89cd87cd38839056a0f3e
  file: app.js
  type: temporary
  reason: Needed for the debug toolbar.
  expires: 2026-10-29
  line: 2
```

The write prompt is the last gate and it defaults to *no*: Enter there prints
`nothing written — the proposed record stays unwritten.` and the proposed record is gone.
`run another session? [y/N]` loops back to the top, re-reading the registry and the debt
list as the previous session left them, so a second record can be written in the same
invocation; Enter finishes.

## The expiry ladder

One decision for the whole write, three rungs, in this order:

1. **Accept the default** — `a default expiry of <date> (N days from today) is set —
   accept it? [Y/n]`. Enter accepts. On a renewal this echoes `new expiry: <date>`.
2. **Make it permanent** — `make this a permanent exception? [y/N]`. `y` prints
   `permanent exceptions require an approver.` and the record carries `type: permanent`
   with no `expires`.
3. **Pick a date** — `new expiry — YYYY-MM-DD, no later than <max>:`, with the maximum
   resolved against today and stated inline.

A wrong answer to rung 1 or 2 is refused with a restatement of the options. The date prompt
has three distinct refusals, and only the last two escalate:

```text
new expiry — YYYY-MM-DD, no later than 2026-12-29:
❯ tomorrow
type a date as YYYY-MM-DD — e.g. 2026-10-29, up to 2026-12-29
new expiry — YYYY-MM-DD, no later than 2026-12-29:
❯ 2026-02-30
not a real date — use YYYY-MM-DD (e.g. 2026-10-29), up to 2026-12-29
new expiry — YYYY-MM-DD, no later than 2026-12-29:
❯ 2020-01-01
✘ 2020-01-01 is in the past. Choose a future date no later than 2026-12-29, or make it permanent.
make this a permanent exception? [y/N]
❯ n
new expiry — YYYY-MM-DD, no later than 2026-12-29:
❯ 2099-01-01
✘ 2099-01-01 is later than the max (2026-12-29). Choose a date no later than 2026-12-29, or make it permanent.
make this a permanent exception? [y/N]
❯ n
new expiry — YYYY-MM-DD, no later than 2026-12-29:
❯ 2026-11-30
expiry: change → 2026-11-30
```

A malformed or calendar-invalid date restates the format and asks again — you stay on the
prompt. A past or beyond-max date is refused *and* the permanent question is re-offered as
the escape hatch; declining it returns you to the date prompt. Today itself is a valid
expiry, through the end of that UTC day.

Rung 1 is held to the same ceiling as rung 3, and a refused default is re-offered the same
way: a hand-typed date past the maximum prints the gate's own line,
`✘ EXPIRY_POLICY — newly written expires <date> for <rule> in <file> runs past the
baseline <max> maximum (on or before <last date allowed>)`, and drops you at the permanent
question. In practice a `defaultExpiry` cannot reach that branch — the config's own
`defaultExpiry > maxExpiry` check refuses a policy that would prefill past the ceiling —
but the check is there, so a prefilled date can never become a record the gate would fail.

Permanents are orthogonal to the maximum — a permanent carries no date to refuse. What it
does need is the approver, which is why rung 2 says so.

## More than one record at a time

Select several suppressions with a comma-separated list of numbers, and the session asks
whether they share a reason:

```text
  1) app.js:2  no-console  (next-line, new)
  2) app.js:4  no-debugger  (next-line, new)
select which to record (numbers — e.g. 1, or 1,2):
❯ 1,2
◉ selected  app.js:2  no-console  (next-line)
◉ selected  app.js:4  no-debugger  (next-line)
Do these 2 exceptions all share one reason? [Y/n]
❯ n
reason for record 1 of 2 — app.js:2:
❯ First one.
reference (issue / PR / ticket link) for record 1 of 2 — app.js:2 — optional; Enter to skip:
reference (issue / PR / ticket link) for record 1 of 2 — app.js:2 — optional: Skipped
reason for record 2 of 2 — app.js:4:
❯ Second one.
reference (issue / PR / ticket link) for record 2 of 2 — app.js:4 — optional; Enter to skip:
reference (issue / PR / ticket link) for record 2 of 2 — app.js:4 — optional: Skipped
a default expiry of 2026-10-29 (30 days from today) is set — accept it? [Y/n]
expiry: 2026-10-29
Review — the record(s) to write:
  • no-console @ app.js:2 — next-line (new) — expires 2026-10-29
    reason:    First one.
  • no-debugger @ app.js:4 — next-line (new) — expires 2026-10-29
    reason:    Second one.
write the exception? [y/N]
❯ y
✎ exception records written to .pocket-zipper/exceptions.yml
```

Answer `Y` (or Enter) to the share question and one reason and reference are stamped into
every selected record instead, with no per-record interview. Either way the expiry is one
decision for all of them, and every selected suppression earns its own record — one record
authorizes one logical suppression, and a shared reason does not change that. (See
[matching and allocation](exceptions.md#matching-and-allocation) for why a twin pool needs
a record each.)

## Renewal

Rung `2` of the session choice. It lists every temporary record with where it lives and how
long it has left, and edits the chosen one's `expires` **where it is written**:

```text
$ pocket-zipper exception add
reading the working tree's new debt…
this session is for:
  1) new debt from this change
  2) renew an expiring record
choose — 1 (new debt) or 2 (renew):
❯ 2
→ renewal — expiring record:
  1) no-console @ app.js:2 — expires 2026-10-15 (in 16d)
select which to renew (number — 1):
❯ 1
⤷ renewing no-console @ app.js:2
a default expiry of 2026-10-29 (30 days from today) is set — accept it? [Y/n]
new expiry: 2026-10-29
Review — the record(s) to write:
  • no-console @ app.js:2 — next-line (renewal) — expires 2026-10-29
    reason:    needed
    reference: #1
write the exception? [y/N]
❯ y
✎ the existing record's expiry is now 2026-10-29
it takes effect only once the change is approved and merged.

Next steps
  1. the renewal updates the existing record's expiry in place
  2. submit it in a PR — an approver reviews and merges it
run another session? [y/N]
```

Four things to note.

- **The record's pool does not grow.** The renewal edits the entry in place; the registry
  keeps one record for that suppression, and a twin pool keeps its size. Appending a second
  record instead is a shape the validator reports as `RENEWAL_BY_APPEND`.
- **The confirmation differs from a new record's**, and so do the next steps — a renewal
  gets the protected-track guidance in *every* landing mode, while a new record's guidance
  is the two-step unless the repo has opted into combined landing. Why: a renewal raises no
  policy-change signal at all (it changes no match slot), so nothing but the protected path
  distinguishes it. See
  [landing an exception](landing-an-exception.md#combined-landing-opt-in).
- **The same expiry ceiling applies**, with no partial credit: a renewal that shortens an
  overlong record but still runs past the maximum is refused.
- **Permanents are not listed.** A permanent has no date to renew. Turning one back into a
  temporary is a different edit than this branch offers — edit the record yourself, or
  delete it and write a new one.

## What it refuses, and what it says

| Situation | What you get |
|---|---|
| No `config.yml` at the baseline | `Pocket Zipper isn't configured in this repo (no .pocket-zipper/config.yml)` / `nothing can be written here — config is set up by the repo's authorizers at install time, not by this flow` — exit 1 |
| No new debt in the working tree | `no new debt from this change requires an exception.` — exit 0 |
| No temporary record to renew | `no temporary record in this registry to renew — a renewal edits an existing record's expires in place.` — exit 0 |
| Empty reason | `the reason is required — type it (Enter has no meaning here)` — re-asks |
| `--reason` or `--reference` without `--from` | `--reason and --reference require --from <file:line>` plus the usage block — exit 2 |
| `--from` matching no new debt | `no new debt at <file>:<line>` — exit 1 |
| `--from` on an ambiguous line | `2 suppressions sit at <file>:<line> — --from cannot choose between them; record them in an interactive session` — exit 1 |
| A registry in the working tree that cannot be read | the shared validator's diagnostics, one per defect — exit 2 |
| A bare checkout | `exception add requires a work tree` — exit 2 |

A registry with defects is refused before a single question is asked — the same validator
`pocket-zipper validate` uses, with the same lines, so a broken registry is caught before
the interview rather than after the write.

## What it will not do

- **It will not authorize anything.** It writes to your working tree, and says so:
  `it takes effect only once the change is approved and merged.` The change still has to
  carry the record through your host's protected review.
- **It will not write `config.yml`.** No config at the baseline and the flow stops. The
  tool never scaffolds policy; that is an authorizer's or onboarding's job. (`check` itself
  is happy to run zero-config — it is only *writing* a record that needs governance.)
- **It will not delete or clean up.** There is no removal surface here. Unused records are
  found with `validate` and removed by hand through a protected PR — see
  [Cleaning up unused exceptions](cleaning-up-unused-exceptions.md).
- **It will not touch an existing record, except a renewal's `expires` and `type`.** A
  wrong reason, a wrong file scope, a stale `line` — all of those are registry edits you
  make yourself, and `validate` is how you check them.
- **It will not post anywhere, and it will not choose a host.** Combined landing is a
  config decision read from the baseline; the next steps it prints are the two-step
  unless that config already says otherwise.
- **It will not write a defective record.** The proposal is validated before it lands, and
  a refusal prints `✘ nothing written — defects found` with the diagnostics.

## After the write

You have a proposed record in `.pocket-zipper/exceptions.yml` — the file is created on the
first record a repo ever lands, along with `.pocket-zipper/` itself. Run
[`pocket-zipper validate`](exceptions.md#pocket-zipper-validate) if you want the whole
registry re-checked, then follow
[landing guidance](landing-an-exception.md) for your repo's posture.

## Next steps

- [Exceptions: the registry format](exceptions.md) — the fields, the finding vocabulary,
  and when the registry is read.
- [Landing an exception](landing-an-exception.md) — two-step vs combined, and what your
  host can guarantee.
- [Cleaning up unused exceptions](cleaning-up-unused-exceptions.md) — for the records this
  flow will eventually leave behind.
- [Config reference](config-reference.md) — the expiry policy the ladder is held to.
- [Handling a failure](handling-a-failure.md) — reading the report the ride-along starts
  from.
