# Bitbucket Cloud

Add the [`examples/bitbucket-pipelines.yml`](examples/bitbucket-pipelines.yml)
`pull-requests:` pipeline to your `bitbucket-pipelines.yml`, and the lock runs on every
pull request that could add new governed suppression debt. This page explains what the
example does; the ground rules are the [CI wiring principles](principles.md).

## Pipeline surface

The `pull-requests:` pipeline fires when a pull request is created or updated. The branch
selector matches the **source** branch, and `'**'` is the catch-all. Two boundaries shape
it:

- **Fork pull requests do not trigger** the pipeline.
- PR pipelines run **in addition to** the matching branch/default pipeline — a PR against
  a branch that also has a branch pipeline gets two runs.

## Load-bearing: Bitbucket merges before it runs

A `pull-requests:` pipeline **merges the destination branch into the source branch before
it runs**, so HEAD is a merge commit. If the merge fails, the pipeline stops before your
step runs. Unlike GitHub, whose PR merge ref has the base as parent 1, Bitbucket's
wording ("merges the destination branch *into* your working branch") points to the merge
commit's **first parent being the source tip**, the destination tip the second parent.

That's the opposite of what Pocket Zipper's merge-result-first rule expects: it shortcuts
to HEAD's first parent as the baseline **only** when that first parent is the resolved
`--base` ([principles §2](principles.md#2-tree-resolution-is-merge-result-first)), and
here the first parent is the change's own source tree. So the example never relies on
first-parent semantics:

- The example **always passes `--base origin/$BITBUCKET_PR_DESTINATION_BRANCH`**.
- That forces the merge-base path: baseline = `git merge-base(origin/<dest>, HEAD)` — the
  destination head, a direct parent of the merge commit — and proposed change =
  `merge-base..HEAD`, exactly the PR's net change. Correct under either parent order.

> **Confirmed:** Atlassian's docs state the pipeline "merges the destination branch into
> your working branch before it runs," and `git merge` semantics fix the parent order:
> **first parent = source, second = destination**. The force-the-merge-base spelling is
> correct under either ordering, and the example does not rely on parent order.

## Clone and fetch

The default clone is **shallow** (the last 50 commits; `clone: depth:` tunes it globally
or per step). Whether the destination branch ref rides along in that clone is not
documented, so never assume `origin/$BITBUCKET_PR_DESTINATION_BRANCH` resolves. The
example fetches it explicitly:

```sh
git fetch origin "$BITBUCKET_PR_DESTINATION_BRANCH"
```

Pocket Zipper then auto-unshallows, completing the history so the destination's ancestors
are present for the merge-base computation
([principles §1](principles.md#1-a-full-depth-clone-is-mandatory)).

## Evaluation record

`--json pocket-zipper.json` writes the record. Persist it with **step-level**
`artifacts:` — there is **no `definitions: artifacts:` block** (`definitions:` governs
caches, services, and step configs). The step's `artifacts:` lists glob paths relative to
`$BITBUCKET_CLONE_DIR`; `capture-on` **defaults to `always`**, so the record survives a
failed step. Retention is 14 days with a 1 GB per-run limit; downloads live under the
pipeline result's Artifacts tab. To reuse one artifact declaration across steps, share a
step via `definitions: steps:` with an inline `artifacts:` and reference it with a YAML
anchor ([principles §4](principles.md#4-the-evaluation-record-is-the-statistics-artifact)).

Useful PR variables in the step: `$BITBUCKET_PR_DESTINATION_BRANCH` (destination branch),
`$BITBUCKET_PR_ID` (the PR number), `$BITBUCKET_PR_DESTINATION_COMMIT` (the destination's
current commit), `$BITBUCKET_BRANCH` (the PR's source branch).

## Trust: protecting `.pocket-zipper/**`

On this host nothing in a file can block a merge, so the exception guardrail has to live
in branch settings rather than just named in CODEOWNERS. Both halves matter; the second
is the one that decides.

Two layers, and only the second can stop a merge
([principles §5](principles.md#5-the-pocket-zipper-protection-prerequisite)):

**Who is asked to review — code owners (advisory).** Bitbucket Cloud supports a
code-owners file ([copy the example](examples/bitbucket-CODEOWNERS)) that auto-adds
reviewers to PRs touching the listed paths. The authorized approvers are the people named
for `.pocket-zipper/**`:

- **Repo-local team** — define `lock-owners` in `.bitbucket/teams.yaml`
  ([copy the example](examples/bitbucket-teams.yaml)) with contributors by email or
  `"@username"`, then reference it as `@teams/lock-owners`. This is config-as-code and
  needs no workspace-admin rights — editing `contributors` is how approvers are added or
  removed.
- **Workspace group** — reference `@<workspace-slug>/<group-slug>` (managed in the
  workspace UI). A strategy suffix picks who is asked: `:all` asks every member,
  `:random(N)` and `:least_busy(N)` sample.

Code owners are **strictly advisory**: approving happens via the PR's Approve button, but
nothing in the CODEOWNERS file can block a merge. The file is read from the PR's
destination branch.

**The enforced stop — branch restrictions plus a merge check.** Both are UI settings on
the protected branch (no pipeline YAML can express them):

- **Branch restrictions**: restrict write access (no direct write ⇒ changes must come
  through PRs) and restrict who may merge via PR to the lock owners. A branch with
  unrestricted write lets members push straight to it, bypassing CI.
- **Merge checks**: "Minimum number of successful builds for the last commit with no
  failed builds and no in progress builds" (the lock's verdict), and optionally "Minimum
  number of approvals" — the PR author's own approval never counts toward it.

Hard blocking is honest about its tier: **"Prevent a merge with unresolved merge checks"
is a Bitbucket Premium feature**. On Premium it turns every configured merge check
(builds, approvals) into a hard gate; without Premium, unmet merge checks only warn and
users can still merge — enforcement is write/merge restriction plus convention. The
gate's build result is the PR's pipeline status; nothing else is reported (the tool never
calls host APIs).

**No combined landing here:** Bitbucket has no path-scoped approval, so an exception
record and the suppression it authorizes must land in separate PRs — the two-step posture
and why are in [Landing an exception](../guides/landing-an-exception.md).

## Provenance

Every claim above is verified against Atlassian's own documentation and `git merge`
semantics. If a host behavior changes, check those primary sources and update this page —
[back to principles](principles.md), [Bitbucket quick start](../guides/ci/bitbucket.md).