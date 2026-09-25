# GitHub Actions

Copy [`examples/github-actions.yml`](examples/github-actions.yml) to
`.github/workflows/pocket-zipper.yml`, and the lock becomes a required check on every PR
that could add new governed suppression debt. This page explains what that file does; the
ground rules it follows are the [CI wiring principles](principles.md).

## Triggers

- **`pull_request` and `merge_group`** are the gating triggers. `pull_request` evaluates
  the PR's simulated merge. `merge_group` evaluates the merge queue's temporary merge
  commit — a different SHA from the PR, so it needs its own run for the check to report
  on the queue.
- **`push` and `workflow_dispatch`** are the non-PR fallback. They run the merge-base
  path against the default branch, so non-PR flows still evaluate against the target.
- **`pull_request_target` is never eligible.** It checks out the *base* branch, not a
  merge commit — so there's no merge-commit baseline, and the change under evaluation
  isn't even in the checkout. It's also the privileged fork trigger, and recent
  `actions/checkout` (v7) refuses fork-PR checkouts under it. Use `pull_request`.

## Checkout

`actions/checkout@v4` with `fetch-depth: 0` fetches all history for all branches and
tags. The full-history refspec mirrors `refs/heads/*` into `refs/remotes/origin/*`, so
`origin/<target>` resolves from a branch name on every trigger, with no separate unshallow
step (see [principles §1](principles.md#1-a-full-depth-clone-is-mandatory)). The default
checkout is a single shallow commit of the triggering ref — it *cannot* be used.

## `--base` selection

| Trigger | What checkout yields | HEAD a merge commit? | `github.base_ref` | `--base` |
| --- | --- | --- | --- | --- |
| `pull_request` | `refs/pull/<N>/merge` — simulated merge of head into base | Yes, 2 parents (first = base tip) | the target branch | `origin/${{ github.base_ref }}` |
| `merge_group` | merge-group ref (`gh-readonly-queue/<base>/pr-<N>-<sha>`) | Yes — temporary merge commit (first parent = current queue tip) | **empty** | first-parent path applies automatically; the `\|\| 'main'` fallback is inert |
| `push` | pushed branch tip | No | **empty** | `origin/${{ github.base_ref \|\| 'main' }}` → default branch |
| `workflow_dispatch` | selected branch or tag | No | **empty** | same as `push` |

On `pull_request` and `merge_group`, checkout is a **merge commit whose first parent is
the current target tip**, so Pocket Zipper's merge-result-first path applies
([principles §2](principles.md#2-tree-resolution-is-merge-result-first)): the baseline is
`HEAD^1`, and the proposed change is the merged result. On `push` and `workflow_dispatch`
you get a plain tip, so the merge-base path runs. The example's
`--base origin/${{ github.base_ref || 'main' }}` uses `github.base_ref` when the event
provides it (`pull_request`) and falls back to the default branch where it's empty.

## Fork PRs

`${{ github.base_ref }}` always resolves — it comes from the event payload, not from
git. But on a fork PR, the **base ref itself** is on disk only with `fetch-depth: 0`.
The default checkout fetches just the PR merge ref, so `--base origin/<base>` can't
resolve. With `fetch-depth: 0` the base branch is mirrored, and fork PRs resolve exactly
like same-repo PRs.

## Evaluation record

`--json pocket-zipper.json` writes the record, and `actions/upload-artifact@v4` persists
it — with `if: always()`, because the default `success()` skips the upload exactly when
the check fails. The failed step's log is the readable surface (that's where
`pocket-zipper check` prints the human report before exiting 1). The artifact is the
durable record ([principles §4](principles.md#4-the-evaluation-record-is-the-statistics-artifact)).

## Trust: protecting `.pocket-zipper/**`

Trust is where exceptions earn their name. These two controls decide who can approve an
exception record — the difference between a reviewed decision and a self-grant. Nothing
touches the exception registry without passing them.

Both are configured on the base branch
([principles §5](principles.md#5-the-pocket-zipper-protection-prerequisite)):

- **Required status check** named after the lock job (`pocket-zipper`) — a failing or
  absent lock blocks the merge. With a merge queue, require the check against **both**
  `pull_request` and `merge_group`. The queue re-reports the check on its own SHA;
  otherwise merging proceeds unreported.
- **CODEOWNERS review** on `.pocket-zipper/**` — copy
  [`examples/github-CODEOWNERS`](examples/github-CODEOWNERS) to `.github/CODEOWNERS`
  (`/.pocket-zipper/ @org/lock-owners` covers the directory and its subdirectories, hence
  both `config.yml` and `exceptions.yml`), and turn on "Require review from Code Owners"
  and "Do not allow bypassing the above settings". Protect the CODEOWNERS file itself
  (`/.github/CODEOWNERS @repo-owner`) so the policy space can't be rewired.

Picking approvers: for team ownership (`@org/team`), the team's members are the
approvers — change membership in the org, not this file. A bare `@username` works too,
but that person needs write access to the repository.

**Combined landing** (one PR carries an additive exception record and the suppression it
authorizes) is a documented opt-in on GitHub — what to configure, and the fail-open modes
that remain — in [Landing an exception](../guides/landing-an-exception.md).

## Provenance

Every env-var and merge-commit claim above is verified against GitHub's own docs and the
`actions/checkout` and `actions/upload-artifact` sources. If a host behavior changes,
check those primary sources and update this page —
[back to principles](principles.md), [GitHub quick start](../guides/ci/github.md).