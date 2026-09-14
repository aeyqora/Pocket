# GitHub Actions

Copy [`examples/github-actions.yml`](examples/github-actions.yml) as
`.github/workflows/pocket-lock.yml` and the lock becomes a required check on every PR
that adds new governed suppression debt. This page explains what that file encodes;
the ground rules it follows are the [CI wiring principles](principles.md).

## Triggers

- **`pull_request` and `merge_group`** are the gating triggers. `pull_request`
  evaluates the PR's simulated merge; `merge_group` evaluates the merge queue's
  temporary merge commit (a different SHA from the PR, so a separate run is required
  for the check to report on the queue).
- **`push` and `workflow_dispatch`** are the documented non-PR fallback — they run the
  merge-base path against the default branch, so non-PR flows still evaluate against
  the target.
- **`pull_request_target` is never eligible.** It checks out the *base* branch, not a
  merge commit, so there is no merge-commit baseline and the change under evaluation is
  absent from the checkout. It is also the privileged fork-trigger, and recent
  `actions/checkout` (v7) additionally refuses fork-PR checkouts under it. Use
  `pull_request`.

## Checkout

`actions/checkout@v4` with `fetch-depth: 0` — fetch all history for all branches and
tags. The full-history refspec mirrors `refs/heads/*` into `refs/remotes/origin/*`, so
`origin/<target>` resolves from a branch name for every trigger and there is no separate
unshallow step (see [principles §1](principles.md#1-a-full-depth-clone-is-mandatory)).
The default checkout is a single shallow commit of the triggering ref and *cannot* be
used.

## `--base` selection

| Trigger | What checkout yields | HEAD a merge commit? | `github.base_ref` | `--base` |
| --- | --- | --- | --- | --- |
| `pull_request` | `refs/pull/<N>/merge` — simulated merge of head into base | Yes, 2 parents (first = base tip) | the target branch | `origin/${{ github.base_ref }}` |
| `merge_group` | merge-group ref (`gh-readonly-queue/<base>/pr-<N>-<sha>`) | Yes — temporary merge commit (first parent = current queue tip) | **empty** | first-parent path applies automatically; the `\|\| 'main'` fallback is inert |
| `push` | pushed branch tip | No | **empty** | `origin/${{ github.base_ref \|\| 'main' }}` → default branch |
| `workflow_dispatch` | selected branch or tag | No | **empty** | same as `push` |

`pull_request` and `merge_group` check out **merge commits whose first parent is the
current target tip**, so Pocket Lock's merge-result-first path applies
([principles §2](principles.md#2-tree-resolution-is-merge-result-first)): the baseline
is `HEAD^1` and the proposed change is the merged result. `push` and `workflow_dispatch`
are plain tips, so the merge-base path runs. The example's
`--base origin/${{ github.base_ref || 'main' }}` expression uses `github.base_ref`
when the event supplies it (`pull_request`) and falls back to the default branch for
the triggers where it is empty.

## Fork PRs

`${{ github.base_ref }}` always resolves — it comes from the event payload, not from
git. But on a fork PR the **base ref itself** is present locally only under
`fetch-depth: 0`: the default checkout fetches just the PR merge ref, so
`--base origin/<base>` is unresolvable. With `fetch-depth: 0` the base branch is
mirrored and fork PRs resolve exactly like same-repo PRs.

## Evaluation record

`--json pocket-lock.json` writes the record, and
`actions/upload-artifact@v4` persists it — with `if: always()`, because the default
`success()` would skip the upload exactly when the check fails. The failed step's log
(where `pocket-lock check` prints the human report and exits 1) is the readable
surface; the artifact is the durable record
([principles §4](principles.md#4-the-evaluation-record-is-the-statistics-artifact)).

## Trust: protecting `.pocket-lock/**`

Two orthogonal controls, both configured on the base branch
([principles §5](principles.md#5-the-pocket-lock-protection-prerequisite)):

- **Required status check** named after the lock job (`pocket-lock`), so a failing or
  absent lock blocks the merge. When a merge queue is used, the check must be required
  against **both** `pull_request` and `merge_group` — the queue re-reports the check on
  its own SHA and merging would otherwise proceed unreported.
- **CODEOWNERS review** on `.pocket-lock/**` (`/.pocket-lock/ @org/lock-owners`
  covers the directory and subdirectories, hence both `config.yml` and
  `exceptions.yml`), with "Require review from Code Owners" and "Do not allow bypassing
  the above settings" enabled. Protect the CODEOWNERS file itself
  (`/.github/CODEOWNERS @repo-owner`) so the policy space cannot be rewired.

## Provenance

Every env-var and merge-commit claim above is verified against GitHub's own docs and the
`actions/checkout` and `actions/upload-artifact` sources. If a host behavior changes,
verify it against those primary sources and update this page —
[back to principles](principles.md), [GitHub quick start](../guides/ci/github.md).