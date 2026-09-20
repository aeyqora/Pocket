# Pocket Zipper CI wiring principles

> New to Pocket Zipper? Start with the [Guides](../guides/README.md). This page is the deep
> reference for how CI must be wired, not a setup walkthrough.

Every Pocket Zipper CI integration encodes the same six ground rules. Read this page
before any host page; the per-host pages ([GitHub Actions](github.md),
[GitLab CI/CD](gitlab.md), [Bitbucket Cloud](bitbucket.md)) encode exactly these rules
in that host's vocabulary and never restate them. The CLI itself is git-host agnostic:
`pocket-zipper check --base <ref>` is the authoritative gate on every host, and the
wiring is what differs.

The six sections below are the contract a new host page must honor. Adding a fourth
host later means writing one more page — checkout, base-ref variables, artifact
persistence, and trust facts for that host — not reworking this set.

## 1. A full-depth clone is mandatory

The baseline is recomputed from git history on every run. A shallow clone cannot
resolve the base ref, or worse, resolves it against truncated history and yields a
wrong baseline. Assume CI clones shallow by default and force full history with the
host's full-depth switch — GitHub's `fetch-depth: 0`, GitLab's `GIT_DEPTH: 0` — or, where
checkout still cannot be trusted to carry the target ref, an explicit fetch of that
ref before `--base` (Bitbucket).

Pocket Zipper also defends itself: it detects a shallow clone and auto-unshallows before
resolving any ref, and fails closed (`GIT_ERROR`, exit 2) when it cannot. Partial
(promisor) clones fail closed. Treat the auto-unshallow as a safety net, not the
config — full history is a prerequisite of a correct evaluation, not an option.

## 2. Tree resolution is merge-result-first

Two trees are compared: the **baseline** (pre-change state) and the **proposed change**
(post-change state). Each host's checkout yields either a merge result or a plain head.
The rule:

- **Merge-result-first.** When the checked-out HEAD is a two-parent merge commit whose
  first parent is the current target tip — the resolved `--base` ref — the baseline is
  that first parent and the proposed change is the merge result (HEAD). This is the
  CI case: the evaluation lands on the merged result, not on the head alone.
- **Otherwise, merge-base.** The baseline is `git merge-base <resolved --base>
  <HEAD>`, and the proposed change is HEAD.

The two rules are mutually exclusive and the first-parent shortcut is used only in the
exact case where HEAD's first parent *is* the target tip. A merge commit whose first
parent is some other branch (e.g. Bitbucket's PR pipelines) never shortcuts — it falls
to the merge-base path. A naive two-point diff (`git diff base..head`, line-by-line
comparison of two tips) is **never** used: the baseline is a tree, not a diff.

## 3. `--base` selection: resolve a ref, fetch it first

`--base` names the target the change is compared against. Which ref to pass is each
host's decision, but the rule is the same everywhere:

- Map the host's base-ref variable (e.g. `github.base_ref`,
  `CI_MERGE_REQUEST_TARGET_BRANCH_NAME`, `BITBUCKET_PR_DESTINATION_BRANCH`) to a ref
  that actually resolves in the local clone. Prefer a **branch name** over a SHA where
  the variable family is empty in some pipeline kinds.
- **Fetch before `--base`.** CI clones fetch only what the checkout needs. If the
  target branch is absent locally, `--base origin/<target>` fails loudly — which is
  correct behavior, but only if the host config fetches the target first. Two spells:
  the host's full-history switch (so the target rides along with every branch), or an
  explicit `git fetch origin "<target-branch>"` immediately before `--base`.
- When the host resolves HEAD as a merge commit whose first parent is the target tip,
  the merge-result path needs no `--base` resolution at all — but passing a sensible
  `--base` keeps the plain-head fallback aligned on `push`-style triggers of the same
  pipeline.

## 4. The evaluation record is the statistics artifact

`pocket-zipper check --json <path>` writes the full evaluation record — both tree ids,
the policy applied, per-suppression dispositions, exception matches, and granular
errors. The record is the statistics artifact: persist it to the host's artifact store
**on failure as well as success** (a failed gate is exactly when the numbers matter).

stdout, by contrast, stays human: it carries the report (verdict, dispositions,
per-file NEW and MATERIALLY-CHANGED suppressions with copy-paste exception records),
not the machine-readable detail. In CI the failed step's log is therefore the human
report, and the artifact is the durable record. Pocket Zipper writes nothing to the
working tree beyond the file you point `--json` at.

## 5. The `.pocket-zipper/**` protection prerequisite

The policy — `.pocket-zipper/config.yml` (governed rules, enablement) and
`.pocket-zipper/exceptions.yml` (authorized new debt) — is the one thing a policy-weakening
change must not get to edit itself. Each host's protection wiring is where **human
approval is counted**; the core is host-agnostic and never reads reviewers. Configure,
per host, the equivalent of:

- a **required check** named after the lock job (so no change merges with a failing
  or absent verdict), and
- **path-gated code review** over `.pocket-zipper/**` (so only approved policy owners
  can touch the policy), protecting the code-owners file itself.

The concrete per-host spells live in the "Trust" section of each host page, and every
[example pipeline](examples/) opens with them — ready-made code-owners files are
provided for the hosts that support them (`examples/github-CODEOWNERS`,
`examples/gitlab-CODEOWNERS`); where a host has no file-based control (Bitbucket), the
example states the required UI settings instead.

Without this protection the exception registry is toothless — an author could weaken
the gate and approve their own debt in one change.

The policy is **baseline-authoritative**: the evaluation always reads the *baseline's*
`.pocket-zipper` files, never the head's. A head-side edit to `config.yml` or
`exceptions.yml` therefore never shapes the current evaluation — it records as a
policy-change signal and takes effect from the next evaluation (one-merge lag). A
policy-weakening edit *consumed by new debt in the same change* fails the gate
(`POLICY_CHANGE`, exit 1); a pure policy edit is recorded but not gate-failed.

## 6. The tool never calls host APIs

Pocket Zipper reads git and ESLint and nothing else. It posts no comments, sets no
status or check statuses, uploads no Code Insights, sends no notifications. Those are
host-side configuration — the trust and reporting wiring in section 5 and the record
artifact in section 4 *are* the integration surface. If a team wants a PR comment or a
pull-status badge, that is a separate host-side concern built on the same artifacts,
not something the lock does.

## Reading order

Copy the example for your host, then read each section above and check the example
against it. The per-host pages ([GitHub](github.md), [GitLab](gitlab.md),
[Bitbucket](bitbucket.md)) spell the same rules in host terms — what the pipeline
checks out, which variable feeds `--base`, what must be fetched first, and how trust
is wired. The [CI quick-start guides](../guides/README.md) are the copy-paste path for
each host.

## Provenance

The per-host pages are written against each host's own documentation and source. This
principles page is host-agnostic by construction and is the seam a future host page slots
into.