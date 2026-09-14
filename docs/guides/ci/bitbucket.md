# Bitbucket Cloud quick start

Run Pocket Lock on every pull request. Add the `pull-requests:` pipeline from
[`examples/bitbucket-pipelines.yml`](../../ci/examples/bitbucket-pipelines.yml) to your
`bitbucket-pipelines.yml`:

```yaml
pipelines:
  pull-requests:
    '**':        # matches the source branch of every PR; fork PRs do not trigger
      - step:
          name: Pocket Lock
          script:
            # PR pipelines merge the destination into the source, so HEAD's first
            # parent is the source, not the baseline; always force the merge-base
            # path with an explicit --base and never rely on parent order.
            - git fetch origin "$BITBUCKET_PR_DESTINATION_BRANCH"
            - npm ci
            - npx pocket-lock check --base "origin/$BITBUCKET_PR_DESTINATION_BRANCH" --json pocket-lock.json
          artifacts:
            # capture-on defaults to always, so this survives a failed check.
            - pocket-lock.json
```

## What makes it work

- **Always pass `--base origin/$BITBUCKET_PR_DESTINATION_BRANCH`.** Bitbucket merges the
  destination branch into the source before the pipeline runs, so `HEAD` is a merge
  commit and the generic first-parent shortcut does not apply. Passing `--base` forces
  the merge-base path, which is correct regardless of parent order.
- **`git fetch origin "$BITBUCKET_PR_DESTINATION_BRANCH"`** — the default clone is
  shallow and the destination ref may be absent. Fetch it before `--base`; Pocket Lock
  then auto-unshallows.
- **Step-level `artifacts:`** — `capture-on` defaults to `always`, so the record survives
  a failed check. There is no `definitions: artifacts:` block.

## Make it required and protect the policy

- Apply **branch restrictions** to the protected branch: restrict write access (so
  changes must come through PRs) and restrict who may merge.
- Add a **merge check** requiring the last commit's build to succeed. Note that hard
  blocking ("Prevent a merge with unresolved merge checks") is a Bitbucket Premium
  feature; on lower tiers unmet checks warn but do not block.

## Deep reference

This page is the copy-paste path. For the merge-before-run semantics, fork-PR behavior,
and artifact retention details, see [docs/ci/bitbucket.md](../../ci/bitbucket.md). The
host-agnostic ground rules are in
[CI wiring principles](../../ci/principles.md).

Back to [guides](../README.md) · [Troubleshooting](../troubleshooting.md)
