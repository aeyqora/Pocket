# GitHub Actions quick start

Add Pocket Zipper as a required check on every pull request. Copy
[`examples/github-actions.yml`](../../ci/examples/github-actions.yml) to
`.github/workflows/pocket-zipper.yml`:

```yaml
name: pocket-zipper

on:
  pull_request:
  # The merge queue reports a separate check on its temporary merge commit;
  # without this trigger the lock cannot be the required check for the queue.
  merge_group:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

jobs:
  pocket-zipper:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0            # full history: the --base ref must resolve
      - run: npm ci
      - name: Pocket Zipper
        run: |
          npx pocket-zipper check \
            --base origin/${{ github.base_ref || 'main' }} \
            --json pocket-zipper.json
      # Persist the evaluation record even when the check fails.
      - name: Upload Pocket Zipper evaluation record
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: pocket-zipper
          path: pocket-zipper.json
```

## What makes it work

- **`fetch-depth: 0`** — the baseline is recomputed from git, so the target branch has to
  be present locally. A shallow checkout makes `--base` unresolvable, or the baseline
  wrong.
- **`--base origin/${{ github.base_ref || 'main' }}`** — `github.base_ref` is set on
  `pull_request` and empty on `push`/`workflow_dispatch`, where the fallback targets the
  default branch. On `pull_request` and `merge_group` the checkout is a merge commit
  whose first parent is the target tip, so Pocket Zipper evaluates the merged result.
- **`if: always()` on the upload** — the record is the statistics artifact, and it matters
  most exactly when the check fails.

## Make it required and protect the policy

This is where exception records get approved. Nothing in `.pocket-zipper/exceptions.yml`
can land except through the review wired up here, so the controls below are what make an
exception a review rather than a self-serve edit.

- Add the `pocket-zipper` job as a **required status check** on the base branch. With a
  merge queue, require it for both `pull_request` and `merge_group`.
- Add a **CODEOWNERS** rule covering `.pocket-zipper/**` and enable "Require review from
  Code Owners". Protect the CODEOWNERS file itself. This is what gives the exception
  registry teeth — copy the ready-made
  [`examples/github-CODEOWNERS`](../../ci/examples/github-CODEOWNERS) to
  `.github/CODEOWNERS` and replace the example owners. The example pipeline file above
  also opens with both required settings.

On GitHub, a repo may also opt into **combined landing** (one PR carries an additive
exception and the suppression it authorizes) — an explicit `allowSameChangeExceptions`
config plus the per-path protection above. What that guarantees, and which failure modes
it inherits, is in [Landing an exception](../landing-an-exception.md).

## Registry work and the cleanup signal

The gate job above is the only thing the merge depends on. Three surfaces sit beside it,
none of which change the verdict:

- **Exit codes.** `0` pass (and hygiene-only `validate`), `1` gate FAIL — unauthorized new
  debt, a `POLICY_CHANGE`, an `EXPIRY_POLICY`, or a `SEVERITY_FLOOR` — `2` fail-closed
  (`GIT_ERROR`, `ESLINT_ERROR`, `CONFIG_ERROR`, `INTERNAL_ERROR`, or a registry/config
  defect). Keep the step's default behavior: the CLI already exits with the right code.
- **Lint the protected files before you push**, with
  `npx pocket-zipper validate`. It reads the working tree's `config.yml` and
  `exceptions.yml`, prints every finding, and is the maintainer's sweep: unused records
  come with a delete-ready `entry N of M · .pocket-zipper/exceptions.yml:lines` pointer.
  Defects exit 2, hygiene alone exits 0 — so it is safe to run as a second, non-required
  job or a PR-comment step.
- **Author records, never hand-write them**, with
  `npx pocket-zipper exception add` (or accept the ride-along a local `check` FAIL offers
  on a terminal). It prefills the match fields and writes a proposed record to the working
  tree; the change still has to be approved like any other.
- **Surface the cleanup rollup.** Add `--verbose` to the check step and pipe its line into
  a PR comment. It is bare counts, by design — the core posts nothing. Extend the
  `Pocket Zipper` step of the pipeline above; `tee` keeps the log for the grep and the
  step's exit code, which a bare pipe would swallow:

```yaml
      - name: Pocket Zipper
        run: |
          npx pocket-zipper check \
            --base origin/${{ github.base_ref || 'main' }} \
            --json pocket-zipper.json \
            --verbose | tee pocket-zipper.log
      - name: Comment the cleanup rollup
        if: always()
        run: |
          line="$(grep -m1 '^pocket-zipper-cleanup:' pocket-zipper.log || true)"
          [ -n "$line" ] || exit 0
          [ "$line" = "pocket-zipper-cleanup: 0 dangling, 0 spent" ] && exit 0
          gh pr comment --body "$line"
```

The commenting step also needs write permission it does not have by default — add
`issues: write` (or `pull-requests: write`) to the workflow's `permissions:` block, or
attach it to a job that declares it. A stricter team can make a non-zero cleanup **fail
CI** instead — the tool itself never fails on hygiene alone.

## Deep reference

This page is the copy-paste path. For the trigger/checkout/base-ref semantics, fork-PR
behavior, and why `pull_request_target` is never eligible, see
[docs/ci/github.md](../../ci/github.md). The host-agnostic ground rules are in
[CI wiring principles](../../ci/principles.md).

Back to [guides](../README.md) · [Troubleshooting](../troubleshooting.md)