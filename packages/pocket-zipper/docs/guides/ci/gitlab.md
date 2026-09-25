# GitLab CI/CD quick start

Run Pocket Zipper on every merge request. Add the `workflow:rules` fragment and the job
from [`examples/gitlab-ci.yml`](../../ci/examples/gitlab-ci.yml) to your `.gitlab-ci.yml`:

```yaml
workflow:
  rules:
    # Merge request pipelines only; the "when: never" branch stops a duplicate
    # branch pipeline from also running the lock.
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - when: never

pocket-zipper:
  image: node:22
  before_script:
    - npm ci
    # The runner's shallow clone fetched only the MR ref; the target branch is
    # absent locally, so fetch it before --base can resolve it.
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
  script:
    - npx pocket-zipper check --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" --json pocket-zipper.json
  artifacts:
    paths:
      - pocket-zipper.json
    when: always
    expire_in: 30 days
```

## What makes it work

- **`workflow:rules` selects MR pipelines** and its `when: never` branch prevents a
  duplicate branch pipeline from also running. The matching rule must be written inline
  in `.gitlab-ci.yml` — rules pulled in via `include:` don't satisfy GitLab's
  requirement.
- **`git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"`** — the runner clones
  shallow and fetches only the MR ref, so the target branch is absent locally. Fetch it
  (or set `GIT_DEPTH: 0`) before `--base`. Pocket Zipper then auto-unshallows.
- **`artifacts: when: always`** — keeps the evaluation record when the check fails.
  `on_success` (the default) would drop it exactly then.

## Make it required and protect the policy

Every exception record is a policy change, and every one of them lands through this
review. Without it, an MR could add to `exceptions.yml` and approve its own debt in one
change; with it, only your named Code Owners decide.

- Protect the target branch with **"Require merge requests"** and **"Pipelines must
  succeed"** so a failing lock blocks the merge.
- Enable **Code Owner approval** and add a rule matching `.pocket-zipper/**` — copy the
  ready-made [`examples/gitlab-CODEOWNERS`](../../ci/examples/gitlab-CODEOWNERS) to
  `.gitlab/CODEOWNERS` and replace the example owners. Only direct
  members of the eligible groups can approve, so keep the policy-owning group tight.

Two tier truths to know: **code-owner approval requires a Premium/Ultimate license** (on
GitLab Free there are no required approvals at all — a registry MR can merge with zero),
and a repo on Premium/Ultimate may opt into **combined landing** (one MR carries an
additive exception and the suppression it authorizes). The per-tier breakdown and
failure modes are in [Landing an exception](../landing-an-exception.md).

## Deep reference

This page is the copy-paste path. For detached vs merged-results pipelines, the MR-only
variable table, and the empty `*_BRANCH_SHA` gotcha, see
[docs/ci/gitlab.md](../../ci/gitlab.md). The host-agnostic ground rules are in
[CI wiring principles](../../ci/principles.md).

Back to [guides](../README.md) · [Troubleshooting](../troubleshooting.md)