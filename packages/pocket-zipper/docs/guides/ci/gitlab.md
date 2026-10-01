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

## Registry work and the cleanup signal

The gate job above is the only thing the merge depends on. Three surfaces sit beside it,
none of which change the verdict:

- **Exit codes.** `0` pass (and hygiene-only `validate`), `1` gate FAIL — unauthorized new
  debt, a `POLICY_CHANGE`, an `EXPIRY_POLICY`, or a `SEVERITY_FLOOR` — `2` fail-closed
  (`GIT_ERROR`, `ESLINT_ERROR`, `CONFIG_ERROR`, `INTERNAL_ERROR`, or a registry/config
  defect). Keep the job's default behavior: the CLI already exits with the right code.
- **Lint the protected files before you push**, with
  `npx pocket-zipper validate`. It reads the working tree's `config.yml` and
  `exceptions.yml`, prints every finding, and is the maintainer's sweep: unused records
  come with a delete-ready `entry N of M · .pocket-zipper/exceptions.yml:lines` pointer.
  Defects exit 2, hygiene alone exits 0.
- **Author records, never hand-write them**, with
  `npx pocket-zipper exception add` (or accept the ride-along a local `check` FAIL offers
  on a terminal). It prefills the match fields and writes a proposed record to the working
  tree; the MR still has to be approved like any other.
- **Surface the cleanup rollup.** Add `--verbose` to the check job and grep its line. It is
  bare counts, by design — the core posts nothing:

```yaml
  pocket-zipper:
    image: node:22
    before_script:
      - npm ci
      - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    script:
      - npx pocket-zipper check --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" \
          --json pocket-zipper.json --verbose | tee pocket-zipper.log
      # A bare count line for whatever turns the log into a notification shape:
      - grep -m1 '^pocket-zipper-cleanup:' pocket-zipper.log || true
    artifacts:
      paths:
        - pocket-zipper.json
      when: always
      expire_in: 30 days
```

`tee` keeps the log for the grep and the job's exit code, which a bare pipe would
swallow. On a merge-request pipeline the same line can be turned into an MR note from
`$CI_SERVER_URL` / `$CI_PROJECT_ID` / `$CI_MERGE_REQUEST_IID`; a stricter team can make a
non-zero cleanup **fail the job** instead — the tool itself never fails on hygiene alone.

## Deep reference

This page is the copy-paste path. For detached vs merged-results pipelines, the MR-only
variable table, and the empty `*_BRANCH_SHA` gotcha, see
[docs/ci/gitlab.md](../../ci/gitlab.md). The host-agnostic ground rules are in
[CI wiring principles](../../ci/principles.md).

Back to [guides](../README.md) · [Troubleshooting](../troubleshooting.md)