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

- **`fetch-depth: 0`** — the baseline is recomputed from git, so the target branch must
  be present locally. A shallow checkout makes `--base` unresolvable or the baseline
  wrong.
- **`--base origin/${{ github.base_ref || 'main' }}`** — `github.base_ref` is set on
  `pull_request` and empty on `push`/`workflow_dispatch`, where the fallback targets the
  default branch. On `pull_request` and `merge_group` the checkout is a merge commit
  whose first parent is the target tip, so Pocket Zipper evaluates the merged result.
- **`if: always()` on the upload** — the record is the statistics artifact and matters
  most exactly when the check fails.

## Make it required and protect the policy

- Add the `pocket-zipper` job as a **required status check** on the base branch. With a
  merge queue, require it for both `pull_request` and `merge_group`.
- Add a **CODEOWNERS** rule covering `.pocket-zipper/**` and enable "Require review from
  Code Owners". Protect the CODEOWNERS file itself. This is what gives the exception
  registry teeth.

## Deep reference

This page is the copy-paste path. For the trigger/checkout/base-ref semantics, fork-PR
behavior, and why `pull_request_target` is never eligible, see
[docs/ci/github.md](../../ci/github.md). The host-agnostic ground rules are in
[CI wiring principles](../../ci/principles.md).

Back to [guides](../README.md) · [Troubleshooting](../troubleshooting.md)
