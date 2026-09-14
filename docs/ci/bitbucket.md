# Bitbucket Cloud

Add the [`examples/bitbucket-pipelines.yml`](examples/bitbucket-pipelines.yml)
`pull-requests:` pipeline to your `bitbucket-pipelines.yml` and the lock runs on every
pull request that could add new governed suppression debt. This page explains what the
example encodes; the ground rules are the [CI wiring principles](principles.md).

## Pipeline surface

The `pull-requests:` pipeline fires when a pull request is created or updated; the
branch selector matches the **source** branch, and `'**'` is the catch-all. Two
boundaries that shape it:

- **Fork pull requests do not trigger** the pipeline.
- PR pipelines run **in addition to** the matching branch/default pipeline — a PR
  against a branch that also has a branch pipeline gets two runs.

## Load-bearing: Bitbucket merges before it runs

A `pull-requests:` pipeline **merges the destination branch into the source branch
before it runs**, so HEAD is a merge commit. If the merge fails, the pipeline stops
before your step runs. Unlike GitHub, whose PR merge ref has the base as parent 1,
Bitbucket's wording ("merges the destination branch *into* your working branch") points
to the merge commit's **first parent being the source tip**, the destination tip the
second parent.

That is the opposite of what Pocket Lock's merge-result-first rule expects: it
shortcuts to HEAD's first parent as the baseline **only** when that first parent is the
resolved `--base` ([principles §2](principles.md#2-tree-resolution-is-merge-result-first)),
and here the first parent is the change's own source tree. The explanation therefore
never relies on first-parent semantics:

- The example **always passes `--base origin/$BITBUCKET_PR_DESTINATION_BRANCH`**.
- That forces the merge-base path: baseline = `git merge-base(origin/<dest>, HEAD)`
  — the destination head, a direct parent of the merge commit — and proposed change =
  `merge-base..HEAD`, exactly the PR's net change. Correct under either parent order.

> **Confirmed:** Atlassian's docs state the pipeline "merges the destination
> branch into your working branch before it runs," and `git merge` semantics fix the
> parent order: **first parent = source, second = destination**. The force-the-merge-base
> spelling is correct under either ordering, and the example does not rely on parent order.

## Clone and fetch

The default clone is **shallow** (the last 50 commits; `clone: depth:` tunes it
globally or per step). Whether the destination branch ref rides along in that clone is
not documented, so never assume `origin/$BITBUCKET_PR_DESTINATION_BRANCH` resolves. The
example fetches it explicitly:

```sh
git fetch origin "$BITBUCKET_PR_DESTINATION_BRANCH"
```

and Pocket Lock's auto-unshallow completes the history so the destination's ancestors
are present for the merge-base computation
([principles §1](principles.md#1-a-full-depth-clone-is-mandatory)).

## Evaluation record

`--json pocket-lock.json` writes the record. Persist it with **step-level**
`artifacts:` — there is **no `definitions: artifacts:` block** (`definitions:` governs
caches, services, and step configs). The step's `artifacts:` lists glob paths relative
to `$BITBUCKET_CLONE_DIR`; `capture-on` **defaults to `always`**, so the record
survives a failed step. Retention is 14 days and there is a 1 GB per-run limit;
downloads are under the pipeline result's Artifacts tab. To reuse one artifact
declaration across steps, share a step via `definitions: steps:` with an inline
`artifacts:` and reference it with a YAML anchor
([principles §4](principles.md#4-the-evaluation-record-is-the-statistics-artifact)).

Useful PR variables in the step: `$BITBUCKET_PR_DESTINATION_BRANCH` (destination
branch), `$BITBUCKET_PR_ID` (the PR number), `$BITBUCKET_PR_DESTINATION_COMMIT` (the
destination's current commit), `$BITBUCKET_BRANCH` (the PR's source branch).

## Trust: protecting `.pocket-lock/**`

Branch restrictions (branch permissions) plus a merge check
([principles §5](principles.md#5-the-pocket-lock-protection-prerequisite)):

- **Branch restrictions** on the protected branch: restrict write access (no direct
  write ⇒ changes must come through PRs) and restrict who may merge via PR. A branch
  with unrestricted write lets members push straight to it, bypassing CI.
- **Merge check** on the same branch: "Minimum number of successful builds for the last
  commit with no failed builds and no in progress builds".

Hard blocking is honest about its tier: **"Prevent a merge with unresolved merge
checks" is a Bitbucket Premium feature**. Without Premium, unmet merge checks only
warn and users can still merge — enforcement is write-protection plus convention. The
gate's build result is the PR's pipeline status; nothing else is reported (the tool
never calls host APIs).

## Provenance

Every claim above is verified against Atlassian's own documentation and `git merge`
semantics. If a host behavior changes, verify it against those primary sources and update
this page — [back to principles](principles.md),
[Bitbucket quick start](../guides/ci/bitbucket.md).