# Quick start

Get Pocket Zipper running against a repository in about five minutes.

Does your repository already carry a lot of ESLint suppressions that you don't want to
block on? Read [Onboarding an existing codebase](onboarding-existing-codebase.md)
instead — enabling the gate cold would flag every one of them as new debt.

## Prerequisites

- **Node.js** 20 or newer.
- **git** 2.43 or newer. The tool spells its git commands explicitly (including
  `git merge-base A B`).
- **ESLint** 9 or newer (flat config only), installed and configured in the repository.
  Pocket Zipper uses *your* installed ESLint as the semantic authority for which rules
  apply where. Legacy `.eslintrc` configuration is not supported.
- **A full clone.** Shallow clones are auto-unshallowed when possible; partial (promisor)
  clones fail closed. See [Troubleshooting](troubleshooting.md).

## 1. Install

```sh
npm install --save-dev pocket-zipper eslint
```

## 2. Add a config file

Create `.pocket-zipper/config.yml`. The canonical default — what the install docs ship, to
be landed by your repo's authorizers through a protected policy PR — spells every fallback
explicitly:

```yaml
enabled: true
# governedRules:              # optional; absent = every applicable rule is governed
# minSeverities:              # optional; absent = no rule has a severity floor
exceptions:
  defaultExpiry: 30d          # duration literal (Nd / Nmo); fallback 30d
  maxExpiry: 3mo              # duration literal (Nd / Nmo); fallback 3mo
allowSameChangeExceptions: false   # fallback; host required iff this is true
```

The smallest useful config — enough to run a check — is:

```yaml
enabled: true
```

That governs every rule your ESLint configuration makes applicable, and counts a
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
matched. Naming a rule ESLint doesn't recognize at all fails closed (`CONFIG_ERROR`,
exit 2); naming a real rule that doesn't currently apply anywhere is a forward
declaration, not an error.

To enforce a rule's severity band, declare a floor:

```yaml
enabled: true
minSeverities:
  no-console: error    # a change that puts no-console below `error` fails the gate
```

Floors are opt-in: without this map a config weakening records `POLICY_CHANGE` and passes.
With it, a step down is a failure no exception record can cover — you lower the floor in
its own protected policy PR, one merge earlier. See
[the floor is the authorization](config-reference.md#minseverities--the-floor-is-the-authorization).

An absent config file means the same as `enabled: true` with no allowlist. Every key is
documented in the [config reference](config-reference.md), which also carries the migration
note for upgrading to unknown-key rejection.

## 3. Run your first check

```sh
npx pocket-zipper check --base main
```

`--base` is the target you compare against — here, the local `main` branch. Pocket
Zipper resolves the baseline from git and compares it against your current `HEAD` (the
proposed change). It never uses a two-point `git diff`.

To also write the machine-readable evaluation record:

```sh
npx pocket-zipper check --base main --json pocket-zipper.json
```

## 4. Read the verdict

- **PASS** (exit 0) — no unauthorized new suppression debt.
- **FAIL** (exit 1) — the change introduces new or materially-changed debt of a governed
  rule that no exception covers. The report prints a copy-paste exception record for
  each offending suppression; landing one means getting it reviewed by your authorized
  approvers. A config weakening or a floored severity drop can also fail on its own
  (`POLICY_CHANGE`, `SEVERITY_FLOOR`) — see [Handling a failure](handling-a-failure.md).
- **Exit 2** — an operational failure (`GIT_ERROR`, `ESLINT_ERROR`, `CONFIG_ERROR`,
  `INTERNAL_ERROR`; or registry/config defects from `validate`). Nothing was approved. See
  [Troubleshooting](troubleshooting.md).

A failing `check` prints only what you need: the verdict, per-disposition counts, and the
offending suppressions. A passing one prints just the verdict. Colors appear only when
stdout is a terminal.

## Commands

```sh
pocket-zipper check --base <ref> [--json <path>] [--verbose]
pocket-zipper pre-commit [--json <path>] [--verbose]
pocket-zipper validate
pocket-zipper exception add [--from <file:line> --reason <text> --reference <link>]
```

- `check` is the authoritative gate; run it in CI against the target branch.
- `pre-commit` evaluates the staged index for local early feedback. See
  [Pre-commit hook](pre-commit.md).
- `validate` lints both protected files (`config.yml` and `exceptions.yml`) in your working
  tree — run it when you're writing or editing the registry. Defects exit 2; hygiene alone
  exits 0. See [the registry format](exceptions.md#pocket-zipper-validate).
- `exception add` is the wizard for authoring an exception (new debt or renewal), with
  non-interactive flags for scripted/agented use. It is the second front door of the same
  engine a failing local `check` offers you, and the only command that writes to your
  working tree: it appends the records it proposed to `exceptions.yml`, which still have to
  land through review. See [Authoring an exception](authoring-an-exception.md).
- `--json <path>` writes the evaluation record and leaves stdout for the human report.
- `--verbose` reports even on pass: the disposition summary, the per-rule pool counts, new
  debt authorized by an exception, and unused-exception cleanup — in both modes. On a pass
  it also ends with the greppable rollup
  `pocket-zipper-cleanup: N dangling, M spent`, which is the line a repo's own CI step
  greps for; see
  [cleaning up unused exceptions](cleaning-up-unused-exceptions.md#the-cleanup-rollup-and-ci-glue).

## Next steps

- [Onboarding an existing codebase](onboarding-existing-codebase.md)
- [Handling a failure](handling-a-failure.md)
- [Exceptions: the registry format](exceptions.md)
- [Landing an exception](landing-an-exception.md)
- [CI quick-starts](ci/github.md)
- [Config reference](config-reference.md)
- [Troubleshooting](troubleshooting.md)
- Deep reference: [CI wiring principles](../ci/principles.md)