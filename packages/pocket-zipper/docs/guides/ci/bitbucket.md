# Bitbucket Cloud quick start

Run Pocket Zipper on every pull request. Add the `pull-requests:` pipeline from
[`examples/bitbucket-pipelines.yml`](../../ci/examples/bitbucket-pipelines.yml) to your
`bitbucket-pipelines.yml`:

```yaml
pipelines:
  pull-requests:
    '**':        # matches the source branch of every PR; fork PRs do not trigger
      - step:
          name: Pocket Zipper
          script:
            # PR pipelines merge the destination into the source, so HEAD's first
            # parent is the source, not the baseline; always force the merge-base
            # path with an explicit --base and never rely on parent order.
            - git fetch origin "$BITBUCKET_PR_DESTINATION_BRANCH"
            - npm ci
            - npx pocket-zipper check --base "origin/$BITBUCKET_PR_DESTINATION_BRANCH" --json pocket-zipper.json
          artifacts:
            # capture-on defaults to always, so this survives a failed check.
            - pocket-zipper.json
```

## What makes it work

- **Always pass `--base origin/$BITBUCKET_PR_DESTINATION_BRANCH`.** Bitbucket merges the
  destination branch into the source before the pipeline runs, so `HEAD` is a merge
  commit and the generic first-parent shortcut doesn't apply. Passing `--base` forces the
  merge-base path, which is correct regardless of parent order.
- **`git fetch origin "$BITBUCKET_PR_DESTINATION_BRANCH"`** — the default clone is
  shallow and the destination ref may be absent. Fetch it before `--base`; Pocket Zipper
  then auto-unshallows.
- **Step-level `artifacts:`** — `capture-on` defaults to `always`, so the record survives
  a failed check. There is no `definitions: artifacts:` block.

## Make it required and protect the policy

Bitbucket's CODEOWNERS file is advisory, so the guardrail is two-tiered: name the
approvers, then enforce who may merge. Together they keep the exception registry an
approved log instead of a list anyone can edit.

- **Name the approvers**: copy
  [`examples/bitbucket-CODEOWNERS`](../../ci/examples/bitbucket-CODEOWNERS) to
  `.bitbucket/CODEOWNERS` and
  [`examples/bitbucket-teams.yaml`](../../ci/examples/bitbucket-teams.yaml) to
  `.bitbucket/teams.yaml`, editing the `contributors` to your lock owners. PRs touching
  `.pocket-zipper/**` then auto-add every lock owner as a reviewer — advisory only, it
  can't block a merge.
- Apply **branch restrictions** to the protected branch: restrict write access (so
  changes must come through PRs) and restrict who may merge (only the lock owners).
- Add a **merge check** requiring the last commit's build to succeed. Note that hard
  blocking ("Prevent a merge with unresolved merge checks") is a Bitbucket Premium
  feature; on lower tiers unmet checks warn but don't block.

## Registry work and the cleanup signal

The step above is the only thing the merge depends on. Three surfaces sit beside it, none
of which change the verdict:

- **Exit codes.** `0` pass (and hygiene-only `validate`), `1` gate FAIL — unauthorized new
  debt, a `POLICY_CHANGE`, an `EXPIRY_POLICY`, or a `SEVERITY_FLOOR` — `2` fail-closed
  (`GIT_ERROR`, `ESLINT_ERROR`, `CONFIG_ERROR`, `INTERNAL_ERROR`, or a registry/config
  defect). Keep the step's default behavior: the CLI already exits with the right code.
- **Lint the protected files before you push**, with
  `npx pocket-zipper validate`. It reads the working tree's `config.yml` and
  `exceptions.yml`, prints every finding, and is the maintainer's sweep: unused records
  come with a delete-ready `entry N of M · .pocket-zipper/exceptions.yml:lines` pointer.
  Defects exit 2, hygiene alone exits 0.
- **Author records, never hand-write them**, with
  `npx pocket-zipper exception add` (or accept the ride-along a local `check` FAIL offers
  on a terminal). It prefills the match fields and writes a proposed record to the working
  tree; the PR still has to be approved like any other.
- **Surface the cleanup rollup.** Add `--verbose` to the check step and grep its line. It is
  bare counts, by design — the core posts nothing:

```yaml
      - step:
          name: Pocket Zipper
          script:
            - git fetch origin "$BITBUCKET_PR_DESTINATION_BRANCH"
            - npm ci
            - npx pocket-zipper check --base "origin/$BITBUCKET_PR_DESTINATION_BRANCH" \
                --json pocket-zipper.json --verbose | tee pocket-zipper.log
            # A bare count line for whatever turns the log into a notification shape:
            - grep -m1 '^pocket-zipper-cleanup:' pocket-zipper.log || true
          artifacts:
            - pocket-zipper.json
```

`tee` keeps the log for the grep and the step's exit code, which a bare pipe would
swallow. Post it to the PR with `$BITBUCKET_PR_ID`, or — since Bitbucket's CODEOWNERS are
advisory anyway — fail a low-stakes "cleanup report" step so the count carries in the PR
summary. Making a non-zero cleanup fail the *gate* step is a team's own choice; the tool
never fails on hygiene alone.

## Deep reference

This page is the copy-paste path. For the merge-before-run semantics, fork-PR behavior,
and artifact retention details, see [docs/ci/bitbucket.md](../../ci/bitbucket.md). The
host-agnostic ground rules are in [CI wiring principles](../../ci/principles.md).

Back to [guides](../README.md) · [Troubleshooting](../troubleshooting.md)