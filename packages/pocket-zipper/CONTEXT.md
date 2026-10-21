# Pocket Zipper

A CLI that gates a proposed change from adding new ESLint suppression debt, by reconciling
the suppression inventory of a git-derived baseline against the inventory of the change.

## Suppression model

**Suppression debt**:
The governance target: any ESLint suppression directive in the codebase, counted even when it
guards no currently emitted diagnostic. Not the emitted diagnostics themselves.

**Logical suppression**:
One unit of suppression debt: a discrete `(rule, location)` pair for which ESLint's effective
configuration determines a rule is suppressed at a location. A broad directive expands to one
logical suppression per governed rule applicable there; a directive naming several rules
yields several logical suppressions.
_Avoid_: directive (a directive is the raw syntax, an input to recognition, not the counted unit).

**Suppression type**:
One of five shapes the gate counts: the four directive forms (`next-line`, `line`, `block`,
`file-level directive`) plus `config-off` (a rule at severity 0 in the flat config). The four
directive forms are exceptable; `config-off` is not. A new `config-off` is a policy change,
not debt: it is recorded on the policy track (`POLICY_CHANGE`) and fails the gate only when
consumed by new directive debt in the same change. Lowering a governed rule's severity
(`"error"` → `"warn"`, or any step down the off → warn → error ladder) is the same policy
signal even though no suppression shape changes. User-facing reference:
[docs/guides/suppression-types.md](docs/guides/suppression-types.md).

**Guarded rule**:
The ESLint rule a logical suppression suppresses. A broad directive guards only the rules
ESLint's effective configuration determines are actually applicable at that location — never
every rule in the repository. A directive's guarded set can exceed its governed set (see
Governed rule): under an allowlist, guarded rules outside the governed set carry no debt and
are invisible to the lock.

**Governed rule**:
A rule Pocket Zipper's policy places under governance, and therefore counts suppression
debt for. By default every rule ESLint's effective configuration determines applicable; an
optional allowlist can narrow the governed set so teams onboard rules a few at a time. The
governed set is the allowlist intersected with the applicable set. Only suppressions of
governed rules are logical suppressions.

**Suppression continuity**:
The judgment that two logical suppressions in different trees are the same suppression,
decided by the logical suppression's directive identity: its form plus its normalized rule
token. A multi-rule directive therefore yields independent identities, one per governed
rule. The code beneath a directive is never part of its identity: line drift, reordering,
re-indentation, renames, edits near a suppression, and in-place rewrites of the guarded code
all preserve continuity, as do justification edits. Pairing is scoped to one file; a
cross-file pair is allowed only when Git explicitly reports the head path as a rename of
the baseline path. A text-identical comment can still be materially-changed when it is the
tomb shape (see Tomb). Anything else that changes the canonical identity yields a new logical
suppression.

**Disposition**:
The per-suppression verdict reconciliation assigns when comparing trees: existing,
moved-existing, new, removed, or materially-changed (the tomb shape; see Tomb). `removed`
belongs to an unmatched baseline suppression; the other dispositions belong to head-tree
suppressions.

**Fingerprint**:
The deterministic, versioned, line-independent digest that keys a logical suppression's
identity and is the exception registry's primary match field. Defined by ticket 06:
for directive suppressions, `v1:` = hash over the logical suppression's directive text (form
plus its normalized rule token). For `config-off`, canonical text also includes the rule's
normalized scope and config-file identity. Justification, path, position, and guarded content
are excluded — so drift, rename, rewrite, and justification edits never change it. Two
directive suppressions in a file share a fingerprint when their form and rule match; duplicate
occurrences are then a fungible pool, allocated by registry-order records against
head/document-order suppressions. The matcher's guard-context tie-break applies only to
baseline-to-head continuity, never to record allocation.

**Tomb**:
A head-tree logical suppression paired to a baseline twin by directive identity but materially
changed in the tomb shape: for `next-line` and `line`, the identity-canonicalized comment is
newborn (diff-added or guard-moved), the head's guarded content is absent from the baseline
tree, and the twin's guarded line is diff-removed with its content absent from the head tree.
Region forms use continuity alone; a tomb is not a failure of pairing.
A tomb is a materially-changed suppression: new debt, blocked unless excepted. The only
form of material change; everything else under a continuous directive is existing debt.

## Governance model

**Baseline**:
The pre-change state the evaluation compares against: in CI, the current target tip when the
host supplies a merge result (the merge result's first parent), otherwise the merge-base tree;
in pre-commit, HEAD (or the empty tree). Always recomputed from git, never stored or committed
by Pocket Zipper.

**Proposed change**:
The post-change state under evaluation: in CI, the host's merge result when provided, otherwise
the head tree of merge-base..head; in pre-commit, the staged index.
_Avoid_: diff (the diff is the change map, the mechanism; the proposed change is the state).

**Policy**:
The committed tool configuration (`.pocket-zipper/config.yml`) that shapes what debt exists
and whether it is counted: the `enabled` flag (the gate evaluates only when true), the
optional `governedRules` allowlist, the optional `governedPaths`/`ungovernedPaths`
pair declaring the path scope, the optional `exceptions` stanza
(`defaultExpiry`/`maxExpiry`) governing temporary-exception horizons, the optional
`minSeverities` map of Severity floors, and the optional
combined-landing opt-in (`allowSameChangeExceptions` plus the declared `host`) that permits
same-change exceptions. The effective policy is
the baseline's, never the proposed change's. Kept separate from the exception registry, which
authorizes new debt rather than shaping it. If the baseline registry alone is defective, the
registry half may read the head-side file for one change under the poisoned-baseline repair
guards: the change carries the registry, the head file is defect-free, and this baseline policy
parsed cleanly. The effective policy remains the baseline's.

**Governed path**:
A repository path the policy counts suppression debt for: every tracked path by default,
narrowed by the optional `governedPaths` allowlist, then minus the optional
`ungovernedPaths` subtractor — exclusion wins. A suppression in a path outside the governed
set is not a logical suppression on either side of the comparison, so one moved into the set
is new debt; config-offs and severity weakenings are scoped by their config block's declared
reach, never by the config file's own path.
_Avoid_: gated path (the domain's adjective is governed, on both axes).

**Ungoverned path**:
A repository path the policy subtracts from the governed set after the allowlist narrows it;
overlap with `governedPaths` is legal and the ungoverned entry wins. An exception record
whose file sits in an ungoverned path is spent, and pre-excluding a path governance never
claimed is forward declaration, not an error.
_Avoid_: excluded path (the `excluded` verdict is the disabled gate), exempt path
(exceptions are the registry's, one per suppression).

**Severity floor**:
The minimum severity band the Policy declares for one named governed rule
(`minSeverities`), which a proposed change may not put that rule below. The floor
is what makes an ESLint-config weakening gate-fail rather than merely record: an
absent map leaves every step down the `off → warn → error` ladder recorded on the
policy track and passing, which is the shape a repository not yet enforcing
keeps. It is a floor, not a diff — the head must meet it, and the only grace is
for a band already below the floor when the policy declared it: such a rule may
stay where it is and may not be lowered further. A rule the floor does not name
is ungated, so the map is also the statement of which rules are enforced.

**Existing debt**:
Logical suppressions present in the baseline that a proposed change preserves; allowed to remain.

**New debt**:
Exceptable logical suppressions with no continuous baseline counterpart, plus
materially-changed ones; blocked by the gate unless covered by an exception. Net-zero trades
never clear new debt. A new `config-off` reconciles to the `new` disposition like any unpaired
suppression but is not new debt: exceptability is a property of Suppression type, no registry
record may name a `config-off`, and such a change is recorded on the policy track
(`POLICY_CHANGE`) instead. It fails the gate only when the same change introduces new directive
debt. Rather than routed to the host, where the ESLint config is not the policy space.
_Avoid_: added debt, new suppressions (a new suppression may be authorized, see exception).

**Exception**:
The authorization that allows a proposed change to introduce new debt despite the gate:
a committed exception record, scoped to exactly one logical suppression and
optionally time-limited.
_Avoid_: waiver, carve-out, allowance.

**Exception registry**:
The repository file (`.pocket-zipper/exceptions.yml`) that holds every exception record,
kept separate from the lock policy. Its entries may be added or changed only through the
protected policy-change workflow — except that a *new additive* record may be added in the
ordinary change that consumes it, when the policy's combined-landing opt-in is active (see
Same-change exception). A defect-free registry carried by a change may replace a defective
baseline registry under the poisoned-baseline repair guards; that repair is evaluated with empty
baseline coverage and its records cannot authorize debt in the repair change.

**Registry maintainer**:
The party who owns `.pocket-zipper/` (policy and registry) and periodically sweeps unused
exception records no one cleared, consulting git history for a record's author when a nudge or
question is needed. The sole accountability tier for cleanup — a best-effort standing duty,
never a gate failure, never blocks anything; git history is the audit trail. `pocket-zipper
validate` is the sweep: it prints the same delete-ready pointers a failing `check` does, and
exits 0 on them.

**Cleared by this change**:
The annotation on a record whose suppression the current change removed — the one cleanup signal
addressed to the author of the change rather than to a maintainer sweeping later. Derived
suppression-side (the change's removed suppressions × the baseline records), so it is correct
whichever twin record the allocator left over.

**Registry defect**:
A condition of the exception registry under which a record cannot mean what its author
intended: malformed structure, an unknown field, a malformed fingerprint, or a
calendar-invalid date. Fails closed wherever the registry is read, with a precise
diagnostic; a defective registry is never also classified as hygiene.
_Avoid_: validation error, broken entry.

**Poisoned baseline**:
A baseline exception registry contains a Registry defect, so normal
evaluation cannot read the comparison coverage. A change carrying a defect-free replacement
may pass through the narrow repair path: the baseline defect is reported as `BASELINE_DEFECT`,
coverage starts empty, and the repair's records cannot authorize debt in that change. A
defective baseline config has no such path.

**Registry hygiene**:
A well-formed but questionable condition of the exception registry: an unknown rule id,
an overlong, dangling, spent, or expired record, a pool-count or renewal-by-append finding,
or a combined-landing host or owners-file readiness finding. Reported, never a gate failure
on its own.
_Avoid_: lint warning.

**Exception record**:
One entry in the exception registry: rule, suppression type, fingerprint, file (the
record's file scope — matched at both authorization and utilization), type, reason,
reference, an optional expiration date, and an optional line — where the
suppression's directive sat when the record was written; a reader courtesy that
drifts with the code and is never a match input. The fingerprint is the primary link
to the logical suppression it authorizes. A record carries no owner field: its
author is attributed by git history (the audit trail), and cleanup accountability
sits with the registry maintainer.

**Exception match**:
The judgment that an exception record covers a logical suppression, decided by
fingerprint, suppression type, rule, and the record's file scope — never by line
number. A lookalike suppression in another file finds no record and is unauthorized
debt. Matching is a count, not a covering: a record authorizes at most one logical
suppression, so N same-file twins of one match key need N records and no single record
silently covers them all.

**Pool**:
The unit allocation happens in: claimable logical suppressions in one file sharing one match
key, competing for the same records. Evaluation claimability means new or materially-changed
debt; `validate` claims every live suppression. Records step in registry order and each
reserves at most one suppression, and the pairing is recomputed from scratch every evaluation and
never persisted — so nothing about it can go stale. An expired record reserves nothing,
so a valid sibling authorizes past it and document order never manufactures a shortfall.
A pool with more live records than suppressions has surplus records (see Unused
exception); one with more suppressions than records leaves the excess unauthorized new
debt. Reported one step coarser, per `(rule, file)`, as the count line's `matched` /
`used` / `leftover`: leftover counts *records*, so a pool of one record, one used and
none left over says nothing about a second twin left uncovered.
_Avoid_: bucket, group, allocation set.

**Temporary exception**:
An exception record with an expiration date, valid through the end of its UTC date; its
authorization ends after that date unless the record is renewed.

**Permanent exception**:
An exception record without an expiration date, for a suppression intended to remain
indefinitely.

**Expired exception**:
A temporary exception past its expiration date; it can no longer authorize, so the
suppression it covers is treated as unexcepted new debt.

**Overlong exception**:
A temporary exception whose expiration date exceeds the policy's maximum expiry; reported as
registry hygiene and never a gate failure on its own, while any change that newly writes such
a date is refused. An expired record is never also called overlong: expired keeps precedence.
_Avoid_: out-of-policy exception, beyond-max.

**Unused exception**:
An exception record that authorizes nothing. Three shapes: dangling (no *unclaimed*
suppression matching it remains in its file — a surplus record whose matching
suppressions are all already covered by sibling records is dangling too), spent (its
suppression has become existing debt in its file, or de-governed — its rule or path left
the governed set), and expired (a temporary past its date,
which authorizes nothing at all). Reported as cleanup debt, never a gate failure on its own.
Each is reported as a delete-ready pointer — the record's position in the registry, the line
range it occupies, and its own text — so removal is find-in-one-glance; the tool never deletes
one, and a removal is an ordinary protected-PR edit that is never a policy change.

**Delete-ready pointer**:
The address of one unused exception record, printed wherever records are listed as cleanup:
`entry N of M · .pocket-zipper/exceptions.yml:lines`, followed by the record's own text and its
current location. A pointer is the whole of the tool's cleanup output — the core never deletes a
record and never posts about one, so deletion stays an ordinary protected-PR edit, addressed to
no one, with git history as the audit. A record is delete-ready because nothing unclaimed
matches it, not because the tool decided so.
_Avoid_: the remediation block (that is the add-side twin, for records that do not exist yet).

**Registry lines** vs the record's `line`:
Two different numbers in two different files, routinely confused and never interchangeable. An
exception record's `line` is a line of the **source** file, naming the suppression; it is stored,
because the registry is a browsed audit trail and same-file same-rule records are otherwise
indistinguishable. The **registry lines** of a record are its range in `.pocket-zipper/exceptions.yml`,
naming the record; they are derived on every read, because they change the moment anyone edits
the file above them. Neither is derivable from the other, and a stale stored `line` is
informational only.
_Avoid_: "span" for the registry range — the word sits too easily beside `line`, which means
something else.

**Exception renewal**:
Changing a temporary exception's expiration date, including converting it to permanent; a
protected policy edit requiring fresh authorization. It never qualifies as a Same-change
exception: the renewal itself raises no `POLICY_CHANGE`, while an expired baseline record
leaves the debt unauthorized.

**Same-change exception**:
An exception record added and consumed within the same proposed change — the record lands in
the ordinary PR alongside the suppression it authorizes, instead of one merge earlier. Permitted
only where the policy's combined-landing opt-in is active (`allowSameChangeExceptions`, with a
declared host from the can-guarantee set), only for an *additive* new record (its file plus
match key is new at baseline, with no unmatched baseline record to account for it), and only
when the baseline — never the head — already permits it.
Identity-field edits and renewals never qualify: they stay on the protected policy-change track.
_Avoid_: one-PR exception; same-change authorization (that phrase belongs to the host's
per-path approval, not the record).
