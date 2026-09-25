# GitLab CI/CD

Drop the [`examples/gitlab-ci.yml`](examples/gitlab-ci.yml) `workflow:rules` fragment and
job into your `.gitlab-ci.yml`, and the lock runs on every merge request that could add
new governed suppression debt. This page explains what the example does; the ground rules
are the [CI wiring principles](principles.md).

## Selecting the MR pipeline

There is **no top-level `pipelines:` keyword**. The vocabulary is `workflow:rules`
(gates the whole pipeline) versus job `rules:` (gates one job). Merge request pipelines
are opt-in: they run only when a rule matches `$CI_PIPELINE_SOURCE == "merge_request_event"`,
and the matching rule must be written inline in `.gitlab-ci.yml` — `rules:`/`workflow:`
pulled in via `include:` don't satisfy the requirement.

The example's `workflow:rules` runs the pipeline only for MR events and uses `when: never`
otherwise. That `when: never` is what avoids the duplicate-pipeline footgun: when rules
match both a branch pipeline and an MR pipeline, GitLab runs both.

## What the runner checks out

| Pipeline type | HEAD shape | Pocket Zipper path | Tier |
| --- | --- | --- | --- |
| Branch pipeline (default) | single-parent commit on the branch | merge-base | — |
| Detached MR pipeline (default MR pipeline) | single-parent commit (MR head `refs/merge-requests/<iid>/head`) | merge-base | Free |
| Merged results pipeline | **two-parent merge commit** whose first parent is the target tip | merge-result first-parent | Premium |
| Merge train pipeline | queue of MRs merged into target | does not compare `target..HEAD` as one MR's change | Premium |

The **detached MR pipeline is the documented default** and what the example targets:
HEAD is a single-parent commit, so the merge-base path runs
([principles §2](principles.md#2-tree-resolution-is-merge-result-first)). The exact base is
`$CI_MERGE_REQUEST_DIFF_BASE_SHA` — the base SHA of the MR diff, GitLab's own computed
merge-base — and `origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME` is the by-name alternative
the example uses.

The **merged results pipeline** (Premium) is the first-parent alternative: its HEAD is a
temporary two-parent merge commit whose **first parent is the target branch tip** and
whose second parent is the source head, so the first-parent path applies and the baseline
is the target tip. It runs only when both the project setting and the MR pipeline config
are enabled.

## The `--base` resolver trap

The runner clones **shallow by default** (`git depth` 20 for new projects, maximum 1000)
and fetches only the refs GitLab supplies — in a detached MR pipeline that's the MR ref,
**not the target branch**. So `--base origin/<target>` fails with an unresolvable ref
until the target is present locally. The example fetches it first:

```sh
git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
```

and Pocket Zipper's auto-unshallow completes the history
([principles §1](principles.md#1-a-full-depth-clone-is-mandatory)). The simpler
alternative is to disable shallow for the whole pipeline:

```yaml
variables:
  GIT_DEPTH: 0    # fetch all branches and tags each run
```

Caveat: the runner's shallow-fetch and refspec behavior is cited from GitLab's own docs
and source, but hasn't been reproduced against a live MR pipeline. Treat the spell above
as the robust default, not a guarantee.

## MR-only variables

The whole `CI_MERGE_REQUEST_*` family is defined **only in merge request pipelines** —
outside them the variables are unset, so conditionals must not assume they exist.

| Variable | Available | Notes |
| --- | --- | --- |
| `CI_PIPELINE_SOURCE` | all pipelines | `merge_request_event` for MR pipelines, `push` for branch pipelines |
| `CI_DEFAULT_BRANCH` | all pipelines | the project's default branch |
| `CI_MERGE_REQUEST_IID` | MR pipelines only | the MR number |
| `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME` | MR pipelines only | source branch |
| `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` | MR pipelines only | target branch — what `--base` needs |
| `CI_MERGE_REQUEST_DIFF_BASE_SHA` | MR pipelines only | base SHA of the MR diff (GitLab's computed merge-base) |
| `CI_MERGE_REQUEST_EVENT_TYPE` | MR pipelines only | `detached`, `merged_result`, or `merge_train` |
| `CI_MERGE_REQUEST_REF_PATH` | MR pipelines only | e.g. `refs/merge-requests/1/head` |
| `CI_MERGE_REQUEST_TARGET_BRANCH_SHA` | **empty in MR pipelines** | present only in merged results pipelines |
| `CI_MERGE_REQUEST_SOURCE_BRANCH_SHA` | **empty in MR pipelines** | same |

Those two empty `*_BRANCH_SHA` variables are why the example fetches **by branch name**
(`$CI_MERGE_REQUEST_TARGET_BRANCH_NAME`) and never by SHA — in a detached MR pipeline the
SHAs aren't there to resolve.

## Evaluation record

`--json pocket-zipper.json` writes the record, and job `artifacts:` persists it. Use
`when: always` (or `on_failure`): the default `on_success` drops the artifact exactly
when the gate fails ([principles §4](principles.md#4-the-evaluation-record-is-the-statistics-artifact)).
`expire_in` defaults to 30 days (or the instance-wide setting).

## Trust: protecting `.pocket-zipper/**`

An exception record is only as credible as the review it passes. The settings below force
that review onto every `.pocket-zipper/**` change, so adding to the exception registry is
an approval by named Code Owners — not an edit an author makes alone.

Code Owner approval plus a protected branch
([principles §5](principles.md#5-the-pocket-zipper-protection-prerequisite)):

- Protect the `main` branch with **"Require merge requests"** so no one can direct-push
  past the review path — anyone allowed to push to a protected branch skips MR approval
  rules, Code Owners included.
- Enable **Code Owner approval** on the protected branch and add a rule matching
  `.pocket-zipper/**` to its owners — copy
  [`examples/gitlab-CODEOWNERS`](examples/gitlab-CODEOWNERS) to `.gitlab/CODEOWNERS`.
  Code Owners are direct-group members only: group approvers count only if they belong to
  the eligible group directly, not through an inherited membership.
- **"Pipelines must succeed"** on the MR makes a failing lock block the merge before it
  ever gets to review; when both a branch pipeline and an MR pipeline run, the MR
  pipeline's status is the one used for the merge request.

Only direct members of the eligible groups can approve, so keep the policy-owning group
tight.

Two tier truths: **Code Owner approval requires a Premium/Ultimate license** — on GitLab
Free there are no required approvals at all (a registry MR can merge with zero). Combined
landing is therefore available only on Premium/Ultimate; the per-host head-to-head and
setup are in [Landing an exception](../guides/landing-an-exception.md).

## Provenance

Every env-var, merge-commit, and shallow-fetch claim above is verified against GitLab's
own docs and server source. The runner shallow-fetch behavior is documented but not
reproduced against a live MR pipeline, so treat the fetch-before-`--base` spell as the
robust default. If a host behavior changes, check those primary sources and update this
page — [back to principles](principles.md),
[GitLab quick start](../guides/ci/gitlab.md).