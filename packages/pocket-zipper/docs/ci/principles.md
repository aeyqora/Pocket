# Pocket Zipper CI wiring principles

> New to Pocket Zipper? Start with the [Guides](../guides/README.md). This page is the deep
> reference for how CI must be wired, not a setup walkthrough.

Every CI setup Pocket Zipper ships follows the same six ground rules. Read this page
before you read a host page: [GitHub Actions](github.md), [GitLab CI/CD](gitlab.md), and
[Bitbucket Cloud](bitbucket.md) all say exactly these rules in that host's vocabulary —
and they never repeat them. Pocket Zipper itself doesn't care which host you're on:
`pocket-zipper check --base <ref>` is the authoritative gate everywhere. Only the wiring
around it changes.

Treat the six sections below as the contract a new host page must honor. Adding a fourth
host later means writing one more page — how that host checks out code, which base-ref
variable it exposes, how it keeps artifacts, and what its trust controls are. It does
not mean reworking this set.

## 1. A full-depth clone is mandatory

Every run recomputes the baseline from git history. A shallow clone can't resolve the
base ref — or worse, it resolves it against truncated history and computes a wrong
baseline. Assume the CI clone is shallow unless you say otherwise, and force full history
with the host's switch: GitHub's `fetch-depth: 0`, GitLab's `GIT_DEPTH: 0`. Where
checkout still can't be trusted to carry the target ref (Bitbucket), fetch that ref
explicitly before `--base`.

Pocket Zipper also defends itself. It detects a shallow clone and auto-unshallows before
resolving any ref; if it can't, it fails closed (`GIT_ERROR`, exit 2). Partial (promisor)
clones fail closed too. Treat the auto-unshallow as a safety net, not your config: full
history is a prerequisite for a correct evaluation, not an option.

## 2. Tree resolution is merge-result-first

Pocket Zipper compares two trees, not two diffs: the **baseline** (the state before your
change) and the **proposed change** (the state after it). What the host checks out is
either a merge result or a plain head. The rule:

- **Merge result first.** When the checked-out HEAD is a two-parent merge commit whose
  first parent is the current target tip — the resolved `--base` ref — the baseline is
  that first parent, and the proposed change is the merge result (HEAD). That's the CI
  case: you want the verdict on the merged result, not on the branch head alone.
- **Otherwise, merge-base.** The baseline is `git merge-base <resolved --base> <HEAD>`,
  and the proposed change is HEAD.

The two rules are mutually exclusive. The first-parent shortcut only ever applies in the
one case where HEAD's first parent *is* the target tip. A merge commit whose first parent
is some other branch (Bitbucket's PR pipelines, for example) never shortcuts — it falls to
the merge-base path. A naive two-point diff (`git diff base..head` — comparing two tips
line by line) is **never** used. The baseline is a tree, not a diff.

## 3. `--base` selection: resolve a ref, fetch it first

`--base` names the target your change is compared against. Which ref you pass is each
host's decision, but the rule is the same everywhere:

- Map the host's base-ref variable (`github.base_ref`,
  `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, `BITBUCKET_PR_DESTINATION_BRANCH`) to a ref
  that actually resolves in the local clone. Prefer a **branch name** over a SHA — some
  pipeline kinds leave the SHA variables empty.
- **Fetch before `--base`.** CI clones only fetch what the checkout needs. If the target
  branch isn't local, `--base origin/<target>` fails loudly — that's correct behavior,
  but only if the host config fetches the target first. Two ways to spell it: the host's
  full-history switch (so the target rides along with every branch), or an explicit
  `git fetch origin "<target-branch>"` right before `--base`.
- When the host resolves HEAD as a merge commit whose first parent is the target tip, the
  merge-result path needs no `--base` resolution at all. Still, passing a sensible
  `--base` keeps the plain-head fallback aligned on the `push`-style triggers of the same
  pipeline.

## 4. The evaluation record is the statistics artifact

`pocket-zipper check --json <path>` writes the full evaluation record — both tree ids,
the policy applied, per-suppression dispositions, exception matches, and granular errors.
That record is the stats artifact: persist it **on failure as well as success**. A failed
gate is exactly when the numbers matter.

stdout stays human by contrast. It carries the report — the verdict, dispositions, and
the per-file NEW and MATERIALLY-CHANGED suppressions with copy-paste exception records —
not the machine-readable detail. So in CI, the failed step's log is the human report, and
the artifact is the durable record. Pocket Zipper writes nothing to the working tree
except the file you point `--json` at.

## 5. The `.pocket-zipper/**` protection prerequisite

An exception is the approved way to add new debt — and this wiring is what keeps it
*approved*. Every rule below has one job: turn a change to `.pocket-zipper/**` from a
self-grant into approval by named people. Skip the wiring and the registry is just a file
authors edit. Keep it, and the registry is an approval log.

The policy is the one thing a policy-weakening change must never get to edit itself:

- `.pocket-zipper/config.yml` — governed rules and enablement.
- `.pocket-zipper/exceptions.yml` — authorized new debt.

Each host's protection wiring is where **human approval is counted**; the core is
host-agnostic and never reads reviewers. Per host, configure the equivalent of:

- a **required check** named after the lock job — so no change merges with a failing or
  absent verdict — and
- **path-gated code review** on `.pocket-zipper/**` — so only approved policy owners can
  touch the policy — protecting the code-owners file itself.

The concrete per-host settings live in each host page's "Trust" section, and every
[example pipeline](examples/) opens with them. Each host also ships a ready-made file
naming the authorized approvers: `examples/github-CODEOWNERS`,
`examples/gitlab-CODEOWNERS`, and `examples/bitbucket-CODEOWNERS` with
`examples/bitbucket-teams.yaml`. On GitHub and GitLab, code-owner approval actually
enforces. On Bitbucket the code-owners file only *assigns* reviewers, so the example
pairs it with enforced UI settings — branch restrictions plus a merge check.

Without this protection the exception registry is toothless: an author could weaken the
gate and approve their own debt in one change.

The policy is **baseline-authoritative**: the evaluation always reads the *baseline's*
`.pocket-zipper` files, never the head's. A head-side edit to `config.yml` or
`exceptions.yml` never shapes the current evaluation. It records as a policy-change
signal and takes effect from the next evaluation (one merge of lag). A policy-weakening
edit *consumed by new debt in the same change* fails the gate (`POLICY_CHANGE`, exit 1).
A pure policy edit is recorded but not gate-failed.

Turning a governed rule `"off"` in `eslint.config.*` — or lowering its severity to
`"warn"` — is the same policy-weakening signal, detected even though the config file is
not under `.pocket-zipper/**`: a pure config edit is recorded (`POLICY_CHANGE`) and
passes, and one consumed by new debt in the same change fails the gate. Because
`.pocket-zipper/**` protection does not cover `eslint.config.*`, a team that wants review
on config-off or severity-drop edits should extend its path-gated code review (or
CODEOWNERS) to the ESLint config file too.

## 6. The tool never calls host APIs

Pocket Zipper reads git and ESLint, and nothing else. It posts no comments, sets no
statuses, uploads no Code Insights, sends no notifications. All of that is host-side
configuration. The trust wiring in section 5 and the record artifact in section 4 *are*
the integration surface. If a team wants a PR comment or a status badge, that's a
separate host-side concern built on the same artifacts — not something the lock does.

## Reading order

Copy the example for your host, then read each section above and check the example
against it. The per-host pages ([GitHub](github.md), [GitLab](gitlab.md),
[Bitbucket](bitbucket.md)) say the same rules in host terms — what the pipeline checks
out, which variable feeds `--base`, what must be fetched first, and how trust is wired.
The [CI quick-start guides](../guides/README.md) are the copy-paste path for each host.

## Provenance

The per-host pages are written against each host's own documentation and source. This
page is host-agnostic by design, and it's the seam a future host page slots into.