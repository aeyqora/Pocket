# Quick start

Get Pocket Lock running against a repository in about five minutes.

If your repository already has a lot of ESLint suppressions you do not want to block
on, read [Onboarding an existing codebase](onboarding-existing-codebase.md) instead —
enabling the gate cold would flag all of them as new debt.

## Prerequisites

- Node.js 20 or newer.
- `git` 2.43 or newer. The tool spells its git commands explicitly (including
  `git merge-base A B`).
- ESLint installed and configured in the repository. Pocket Lock uses *your* installed
  ESLint as the semantic authority for which rules apply where.
- A full clone. Shallow clones are auto-unshallowed when possible; partial (promisor)
  clones fail closed. See [Troubleshooting](troubleshooting.md).

## 1. Install

```sh
npm install --save-dev pocket-lock eslint
```

## 2. Add a config file

Create `.pocket-lock/config.yml`. The smallest useful config is:

```yaml
enabled: true
```

This governs every rule that your ESLint configuration makes applicable, and counts a
suppression of any of them as debt.

To onboard rules gradually, add an allowlist:

```yaml
enabled: true
governedRules:
  - no-console
  - jsx-a11y/no-autofocus
```

`governedRules` is an allowlist of exact rule ids, intersected with the rules ESLint
actually makes applicable. Anything outside the allowlist is not counted, reported, or
matched. Naming a rule ESLint does not recognize at all fails closed
(`CONFIG_ERROR`, exit 2); naming a real rule that does not currently apply anywhere is a
forward declaration, not an error.

An absent config file means the same as `enabled: true` with no allowlist.

## 3. Run your first check

```sh
npx pocket-lock check --base main
```

`--base` is the target you compare against — here, the local `main` branch. Pocket Lock
resolves the baseline from git and compares it against your current `HEAD` (the proposed
change). It never uses a two-point `git diff`.

To also write the machine-readable evaluation record:

```sh
npx pocket-lock check --base main --json pocket-lock.json
```

## 4. Read the verdict

- **PASS** (exit 0) — no unauthorized new suppression debt.
- **FAIL** (exit 1) — the change introduces new or materially-changed debt of a governed
  rule that no exception covers. The report prints a copy-paste exception record for
  each offending suppression; see [Handling a failure](handling-a-failure.md).
- **Exit 2** — an operational failure (`GIT_ERROR`, `ESLINT_ERROR`, `CONFIG_ERROR`,
  `INTERNAL_ERROR`). Nothing was approved. See [Troubleshooting](troubleshooting.md).

A passing or failing `check` also prints only what you need: the verdict, per-disposition
counts, and the offending suppressions. Colors appear only when stdout is a terminal.

## Commands

```sh
pocket-lock check --base <ref> [--json <path>] [--verbose]
pocket-lock pre-commit [--json <path>] [--verbose]
```

- `check` is the authoritative gate; run it in CI against the target branch.
- `pre-commit` evaluates the staged index for local early feedback. See
  [Pre-commit hook](pre-commit.md).
- `--json <path>` writes the evaluation record and leaves stdout for the human report.
- `--verbose` reports even on pass.

## Next steps

- [Onboarding an existing codebase](onboarding-existing-codebase.md)
- [Handling a failure](handling-a-failure.md)
- [CI quick-starts](ci/github.md)
- [Troubleshooting](troubleshooting.md)
- Deep reference: [CI wiring principles](../ci/principles.md)
