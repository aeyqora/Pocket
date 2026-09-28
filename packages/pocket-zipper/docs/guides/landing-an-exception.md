# Landing an exception: two-step vs combined

An exception record lands through the same protected review path as the policy —
`.pocket-zipper/**` changes merge only through your host's required approvals. There are
two ways to land one, and the choice is a repository-wide posture, not a per-record
decision:

- **Strict two-step** — the record lands one PR (a protected policy PR); the suppression
  it authorizes lands in a later ordinary PR. The default, and the only posture repos on
  GitLab Free or Bitbucket can honestly run.
- **Combined landing** — the record and the suppression it authorizes land in **one PR**.
  An opt-in your baseline config declares, available only where the host actually
  guarantees a distinct registry approval (GitHub, GitLab Premium/Ultimate).

## Head to head

| | Strict two-step | Combined |
|---|---|---|
| PRs | two (record, then suppression) | one (record + suppression) |
| Registry approval | review on the policy PR | host's path-scoped approval on `.pocket-zipper/**` within the one PR |
| Authorizer bottleneck | two review gates, serialized | one gate |
| What may ride | anything the baseline permits | **additive new records only** — identity-field edits and renewals never qualify |
| Baseline-gated | always | yes — flipping the opt-in on in the same change legalizes nothing |
| Hosts | every flavor | GitHub, GitLab Premium/Ultimate only |
| Fail-open exposure | low (a registry PR is unambiguous) | high if the ruleset/ownership isn't actually configured |

**Combined is not a relaxation of the anti-circumvention model.** It delegates the
"different human approves this path" judgment from a second PR to the host's per-path
approval layer — and that delegation is only real where the host has such a layer and the
repo actually configured it. Where it isn't configured, combined **fails open**: the path
gets no distinct approval and nothing tells you. That is why `validate` exists and why the
setup checklists below are mandatory reading for repos that opt in.

## The process shape of each

### Strict two-step (default)

1. Land the record in a protected policy PR — it sits in the baseline as dangling/cleanup
   until consumed, which is fine and expected.
2. Land the suppression in an ordinary PR. It matches the now-baseline record and is
   authorized.

One serialization detail: the record must be in the *baseline* for the suppression PR.
Until then the suppression reads as unauthorized new debt.

### Combined landing (opt-in)

Prerequisites (all three, checked against the **baseline**, never the head):

- `.pocket-zipper/config.yml` sets `allowSameChangeExceptions: true`, and
- `host` is declared and in the can-guarantee set (`github` or `gitlab-premium`), and
- the host's path-scoped approval is actually configured (checklists below) — because the
  core cannot see it; `validate`'s hygiene findings are the only in-tool signal.

Then a single PR may carry: an **additive** record (a match key absent from the baseline)
plus the suppression it authorizes. Riding records pass every normal check — the expiry
policy (`EXPIRY_POLICY`), the shared validator, and pool allocation. Removals are always
posture-free (they never authorize anything).

**Combined is baseline-gated and additive-only.** Flipping the opt-in on in the same PR as
a record + suppression legalizes nothing — that change is evaluated under the baseline
config, which has combined off. Enabling combined is itself a protected policy change,
landing one merge before the first combined PR. And edits to an existing record's
identity-critical fields (`rule` / `suppression_type` / `fingerprint` / `file`) —
including a re-point to a renamed file, which reads as an identity edit and never as a
fresh grant — stay on the protected track in *both* postures: the delta reads `edit`,
so `POLICY_CHANGE` fires on same-change consumption. A plain renewal (an in-place
expiry edit) is protected by the gate rather than by the signal: it changes the delta
not at all, no `POLICY_CHANGE` fires, and the baseline's expired record authorizes
nothing — so the debt the renewal would cover reads as plain unauthorized new debt and
fails the gate on its own.

## What each host can actually guarantee

The core gate — new governed debt needs a valid exception — works on **every** host. The
question is what the *host* adds on top. Three layers:

- **(a) The core gate** — host-agnostic; every host flavor.
- **(b) Two-step** — works everywhere, *with wrinkles*: **GitLab Free has no required
  approvals at all** (a registry PR can merge with zero approvals — a branch-protection gap,
  not a core gap), and **Bitbucket Cloud's merge-check enforcement requires the Premium
  plan** (lower plans warn only). GitHub and GitLab Premium/Ultimate are the straightforward
  cases.
- **(c) Combined** — **GitHub and GitLab Premium/Ultimate only.** GitLab Free and both
  Bitbucket flavors cannot guarantee a distinct per-path approval, so combined config on
  them fails closed (`CONFIG_ERROR`); they run two-step.

| Host | Core gate | Two-step | Combined |
|---|---|---|---|
| GitHub | yes | yes | yes (ruleset/CODEOWNERS configured) |
| GitLab Premium/Ultimate | yes | yes | yes (code-owner approval toggle) |
| GitLab Free | yes | yes — but **no required approvals at all** | no (config fails closed) |
| Bitbucket Cloud | yes | yes — **enforcement needs Premium** | no (config fails closed) |
| Bitbucket Server/DC | yes | yes | no (config fails closed) |

### Setup checklists

**GitHub** (two-step and combined). CODEOWNERS line owning `.pocket-zipper/**` — and the
CODEOWNERS file itself, per GitHub's own advice — on the default branch; branch protection
requiring PRs, required approvals, and "Require review from Code Owners". For combined,
recommended extras: a ruleset **"Required reviewers"** entry giving `.pocket-zipper/**` a
dedicated approval count (the only way a path can demand *more* approvals than the rest of
the PR), "Do not allow bypassing", and consider "Dismiss stale approvals".

**GitLab** — two-step on any tier (process-shaped on Free). For combined on
**Premium/Ultimate**: a CODEOWNERS section owning the registry (optionally
`[Section][5]` for a dedicated count — the only host where per-path counts stack
natively), the protected-branch toggle "Require approval from code owners", per-MR
approval-rule editing prevented, and awareness that GitLab **auto-approves impossible
rules** (only Ultimate policy rules fail closed instead).

**Bitbucket** (Cloud and Server/DC) — two-step only: branch permissions (merge via PR only)
plus merge checks ("Minimum approvals", optionally "…from default reviewers"); Cloud needs
**Premium** to *enforce* checks — below that they warn only. CODEOWNERS exists but only
adds *suggested reviewers*; there is no path-scoped approval anywhere.

### Fail-open modes to know

These are the ways a combined repo quietly loses its distinct approval. `validate`'s
hygiene findings are the only in-tool signal (the core never reads the host or approval
state):

- **Unowned path** — no CODEOWNERS/ownership for `.pocket-zipper/**`: the path adds no
  requirement at all (GitHub); invalid or missing owners are silently dropped (all hosts).
- **GitLab auto-approve** — an approval rule whose only eligible approver is the MR author,
  or which no eligible approver can satisfy, is auto-approved to unblock the MR.
- **Direct-push and admin bypass** — GitLab "Allowed to push and merge" users skip MR
  approvals entirely (and owners can direct-push their own paths); GitHub admins bypass
  branch protection unless "Do not allow bypassing" is set.

The host's ruleset/ownership is read from the **base/target branch**, never the PR's own
edit — so a same-PR CODEOWNERS relaxation never changes that PR's requirements (safe on all
three hosts).

## Which posture should your repo run?

- **GitHub or GitLab Premium/Ultimate**, and you can commit to keeping the ruleset/owners
  correct → combined removes the authorizer bottleneck; audit it in the same review
  cadence as the ruleset.
- **GitLab Free, Bitbucket, or any repo you can't verify** → stay two-step. It is the
  honest posture where the host cannot separate a registry approval from a code approval,
  and it is what the tool forces when combined isn't can-guaranteed.

The failure shape both postures share is the same gate: the core refuses new governed debt
without an exception. Posture only decides *how many merges* the authorization takes.

## Next steps

- [Exceptions: the registry format](exceptions.md) — the record schema and finding
  vocabulary.
- [Cleaning up unused exceptions](cleaning-up-unused-exceptions.md) — removing records
  safely (deletions are posture-free).
- [Config reference](config-reference.md) — `allowSameChangeExceptions` / `host` exact
  semantics.
- [CI wiring principles §5](../ci/principles.md#5-the-pocket-zipper-protection-prerequisite)
  — the `.pocket-zipper/**` protection prerequisite.