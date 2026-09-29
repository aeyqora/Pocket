# Exceptions: the registry format

An **exception** is a committed record in `.pocket-zipper/exceptions.yml` that authorizes
exactly **one logical suppression**: one directive of one governed rule at one place. It is
how a deliberate new suppression lands despite the gate, in exchange for a written reason, a
reference, and — for the default, expiring kind — a deadline.

This page is the registry companion to [What the gate counts](suppression-types.md). It
covers the record format (which fields are required and which are optional), when the
registry is read and what fails closed, the defect-vs-hygiene finding vocabulary, and the
two working surfaces: `pocket-zipper validate`, which lints the two protected files before
you push, and `pocket-zipper exception add`, the wizard that authors records for you.

## Record format

`exceptions.yml` is a top-level YAML list of records. Each record has a few **match** fields
(what it authorizes), a few **lifecycle** fields (who decided, why, and for how long), and
one **reference** field (a reader courtesy, never a match input):

```yaml
- rule: jsx-a11y/no-autofocus      # (Required) match field
  suppression_type: next-line      # (Required) match field: next-line | line | block | file-level directive
  fingerprint: v1:sha256:…         # (Required) match field; primary key
  file: src/components/Search.tsx  # (Required) match field; the record's file scope
  type: temporary                  # (Required) lifecycle: temporary | permanent
  reason: Autofocus is required for the primary search workflow.   # (Required) lifecycle
  reference: ".../issues/123"      # (Optional) lifecycle — issue / PR / ticket link
  expires: 2026-10-31              # (Required iff type: temporary) lifecycle
  line: 83                         # (Optional) reference data — capture-time, drifts, never a match input
```

| Field | Class | Required? | Notes |
|---|---|---|---|
| `rule` | match | Required | Exact ESLint rule id. |
| `suppression_type` | match | Required | `next-line` \| `line` \| `block` \| `file-level directive`. Not `config-off` — config-level suppressions are never exceptable. |
| `fingerprint` | match | Required | Primary key. `v1:sha256:` plus 64 hex chars; copy it verbatim from the report or wizard — never type it. |
| `file` | match | Required | The record's **file scope** — it only covers suppressions in this file. |
| `type` | lifecycle | Required | `temporary` (expires) or `permanent` (no expires). |
| `reason` | lifecycle | Required | Why this suppression is necessary. The wizard refuses an empty reason. |
| `reference` | lifecycle | Optional | An issue / PR / ticket link. |
| `expires` | lifecycle | Required iff `temporary`; forbidden for `permanent` | Plain `YYYY-MM-DD` (UTC, end of day). |
| `line` | reference | Optional (integer ≥ 1) | The directive's line when the record was written. **Never read by matching** — it drifts with the code and exists so humans can find the directive. |

Three things to know:

- **No `id`, no `approval:` stanza, no `owner`.** The git host governs approval, and git
  history is the audit trail — a stale `owner:` line is now a **defect** (see below), not a
  field. Delete it: `unknown field 'owner' — removed from the registry format; delete this
  line`.
- **Unknown fields are rejected.** `rule`, `suppression_type`, `fingerprint`, `file`,
  `type`, `reason`, `reference`, `expires`, `line` are the only known fields; anything else
  fails closed naming the field.
- **A multi-rule directive needs one record per governed rule.** Each logical suppression is
  independent.

## When the registry is read — and what fails closed

The registry loader runs on **every evaluation**, and it reads the *baseline* registry — the
registry as the last merge left it, never a record staged or committed in the change being
evaluated (one-merge lag). There is exactly one sanctioned exception to that, and it is
narrow: a repo whose *baseline* config opts into [combined landing](landing-an-exception.md#combined-landing-opt-in)
may let a single **additive** record ride the change it authorizes, and only that record
joins coverage. In practice the loader runs in these places:

| Surface | Registry read | Posture |
|---|---|---|
| `check --base <ref>` (CI gate) | baseline registry | Malformed = fail closed (`CONFIG_ERROR`, exit 2) |
| `pre-commit` | HEAD's registry (your baseline for the staged change) | Same fail-closed posture, early feedback only |
| `validate` (working tree) | both `.pocket-zipper/exceptions.yml` and `.pocket-zipper/config.yml` as they sit in your working tree | Defects exit 2; hygiene alone exits 0 |
| Wizard write | the working-tree registry it is about to modify | Refuses to write a defect-producing record |
| Policy-change detection | head-side registry, for broadening vs the baseline | Malformed head = `CONFIG_ERROR`, exit 2 (never "broadening") |

**Failing closed means:** whichever surface reads a registry it cannot interpret — malformed
YAML, a non-list shape, a missing required field, an unknown field, a bad enum, a malformed
fingerprint (`^v1:sha256:[0-9a-f]{64}$`), a calendar-invalid date like `2026-13-45` — the
read fails with exit 2 and a precise diagnostic naming the entry index, the field, the
expected vs actual value, the line/column, and the file path. Defects always fail closed;
**hygiene** never fails the gate on its own.

## Defects vs hygiene — the finding vocabulary

Every registry read flows through one shared validator, so loader, `validate`,
policy-change, and wizard agree. Findings settle on a fixed vocabulary:

**Defects** (fail closed — a record here cannot mean what its author intended): `MALFORMED`,
`UNKNOWN_FIELD`, `MISSING_FIELD`, `INVALID_ENUM`, `FINGERPRINT_FORMAT`, `INVALID_DATE`.

**Hygiene** (reported, never a gate failure on its own): `UNKNOWN_RULE` (the record names a
rule ESLint doesn't know — removing a plugin must not brick every evaluation),
`OVERLONG_EXCEPTION` (past the policy's `maxExpiry`; still authorizes until its date),
`DANGLING_EXCEPTION`, `SPENT_EXCEPTION`, `EXPIRED_EXCEPTION` (see the cleaning guide),
`POOL_COUNTS` and `RENEWAL_BY_APPEND` (shapes of pool mismatch), `HOST_MISMATCH` and
`OWNERS_FILE_READINESS` (combined-landing corroborations, see
[Landing an exception](landing-an-exception.md#the-host-declaration-and-validates-corroborations)).

The tier line: format invariants cannot be violated intentionally — a broken record fails
closed; referential checks can go stale legitimately — a record pointing at a removed rule
fails soft to dangling. A defective registry fails closed *before* any hygiene
classification: a defective record is never also called dangling.

## Matching and allocation

A record covers a logical suppression on **`fingerprint` + `suppression_type` + `rule` +
the record's `file`** — never by line number. The `file` scope means a lookalike
suppression in another file finds **no** record: that suppression is unauthorized new debt
(exit 1), and the record itself classifies `dangling` (or `expired`, which keeps
precedence).

Within a file + match key, **one record authorizes exactly one logical suppression**, as a
consuming count re-computed every evaluation. Expired records never reserve an authorizing
slot; surplus valid records read dangling; a shortfall of records leaves the excess
suppressions unauthorized. The report's per-rule line states the bookkeeping:
`For this rule at this file: N matching records, K used, L leftover`.

## The expiry policy: `expires`, `defaultExpiry`, `maxExpiry`

Temporary records get a concrete `expires` date at authoring, written by the wizard
(`today + defaultExpiry`, default 30 days). The policy's `maxExpiry` (default 3 months) is a
ceiling: **a change that newly writes an expiry beyond the baseline max fails that change**
(`EXPIRY_POLICY`, exit 1) — the one pure-policy shape the core refuses. There is no
partial credit: a renewal that shortens an overlong record but still exceeds the max fails
until it reaches compliance. To allow a longer horizon, bump `maxExpiry` in its own
protected policy PR first — the record lands from the next baseline. Permanents are
orthogonal: `maxExpiry` applies to temporaries only. See the
[expiry policy in the config reference](config-reference.md#exceptions-defaultExpiry--maxExpiry).

## `pocket-zipper validate`

Lint both protected files locally, before CI thrash:

```sh
npx pocket-zipper validate
```

It reads the working tree's `config.yml` and `exceptions.yml`, runs the full inventory —
including the ESLint-dependent checks (rule ids against the known set; the same ESLint load
every `check` pays) — and prints **every** finding, defects and hygiene, each at its record's
live location where it can be derived. Informational only, never a finding class: a record
whose `line` has drifted reads `record says 12, currently at 141` — the record is fine, the
annotation is stale. Exit semantics: no defects → 0 (hygiene alone is a pass); any defect →
2. There is no `--strict` — dangling is a legitimate transient state in the two-step
landing, so hygiene never fails a run by itself.

When to run what: `validate` when you're *writing or editing* the registry; `pre-commit`
for a local verdict on your staged change; `check` is the authoritative CI gate.

## The wizard: `pocket-zipper exception add`

The wizard is the machine-authored authoring surface — one shared engine behind two
front doors:

- the **post-failure ride-along** — after a local `check` FAILs, the flow offers to create
  an exception for the flagged debt (`create an exception for this debt? [y/N]`; Enter
  declines). The failing suppressions are pre-selected, so there is no session choice and
  nothing to re-identify. The offer is made only where someone can answer it: a terminal,
  and not on a `--json` run, whose output belongs to whatever reads the record.
- the **dedicated command** — `pocket-zipper exception add` (`1` new debt / `2` renew),
  with non-interactive flags for scripted and agented use:

```sh
pocket-zipper exception add --from src/components/Search.tsx:83 \
    --reason "Autofocus is required for the primary search workflow." \
    --reference ".../issues/123"
```

What the human types is deliberately small: the match fields (`fingerprint`, `rule`,
`suppression_type`, `file`, `line`) are **never hand-copied** — they are prefilled from a
working-tree inventory recomputed with the same engine `check` reads with. The author only
answers the reason (required — an empty answer is refused), the reference (optional — Enter
to skip), and the expiry. `N` twin suppressions earn `N` records: `Do these N exceptions all
share one reason? [Y/n]` — one interview for all, or per-record interviews in selection
order. The expiry is one decision for the whole write, on a three-rung ladder:

1. accept the prefilled default — `a default expiry of <date> (30 days from today) is set — accept it? [Y/n]` (Enter accepts, echoing `expiry: <date>`, or `new expiry: <date>` on a renewal);
2. `make this a permanent exception? [y/N]` — `y` answers `permanent exceptions require an approver.` and echoes `expiry: permanent — no expires`;
3. `new expiry — YYYY-MM-DD, no later than <max>:` — past and beyond-max dates are distinct refusals, and after any refusal the permanent question is re-offered as the escape hatch.

Rung 1 is held to the same ceiling as rung 3: a `defaultExpiry` that rounds past the
maximum is refused exactly like a hand-typed date (`✘ EXPIRY_POLICY — …`), with the
permanent question re-offered. A malformed or calendar-invalid date at the prompt restates
the format and asks again; only a past or beyond-max date escalates.

Every `[Y/n]`/`[y/N]` honors Enter as its default. The write prompt's Enter declines:
`nothing written — the proposed record stays unwritten.` The wizard validates its own output
through the shared validator and **refuses to write a defect-producing record**; the write
itself is a proposal to the working tree:
`it takes effect only once the change is approved and merged.` It is never the authorizing
step — landing guidance follows the
[posture your repo runs](landing-an-exception.md).

**Renewal edits, never appends.** The renew branch lists every temporary record by
`file:line` + `expires` (with how long it has left) and edits the chosen record's `expires`
in place, or converts it to a permanent — never an append.

**Blocked without config.** If the repo has no `.pocket-zipper/config.yml` at the baseline,
the flow reports itself blocked (exit 1) and hands off to the repo's authorizers — the tool
never scaffolds config, and `check` itself is happy to run zero-config. The
developer-facing narration-off transcript is frozen in the prototype
(`.scratch/exception-flow/prototypes/06-exception-creation-wizard/index.html`);
this page's quoted prompts are the canonical copy.

## Next steps

- [Landing an exception](landing-an-exception.md) — two-step vs combined, and what your
  host can guarantee.
- [Cleaning up unused exceptions](cleaning-up-unused-exceptions.md) — dangling, spent,
  expired, overlong.
- [Config reference](config-reference.md) — the canonical default and every key.
- [Handling a failure](handling-a-failure.md) — reading the FAIL report.