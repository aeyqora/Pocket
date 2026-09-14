# Pocket Zipper

A CLI that gates a proposed change from adding new ESLint suppression debt. It reconciles
the suppression inventory of a git-derived baseline against the inventory of the change
and fails when the change introduces **new** or **materially-changed** suppression debt of
a governed rule that no exception covers.

Suppression directives are debt even when they guard no currently emitted diagnostic, and
a net-zero trade never clears new debt. That is the point: the count can only ratchet
down.

## Install

```sh
npm install --save-dev pocket-zipper eslint
```

Pocket Zipper is a plain-git, host-agnostic Node.js package. Its only runtime inputs are the
repository's installed ESLint (the semantic authority), the `git` binary, and a YAML
parser. There is no hosted service and no committed baseline manifest — the baseline is
recomputed from git on every run.

## Quick start

```sh
# 1. Add a policy file
mkdir -p .pocket-zipper
printf 'enabled: true\n' > .pocket-zipper/config.yml

# 2. Run the authoritative check against your target branch
npx pocket-zipper check --base main
```

- `PASS` (exit 0) — no unauthorized new debt.
- `FAIL` (exit 1) — new or materially-changed debt; the report prints a copy-paste
  exception record for each suppression.
- exit 2 — an operational error (`GIT_ERROR`, `ESLINT_ERROR`, `CONFIG_ERROR`,
  `INTERNAL_ERROR`).

Already have a lot of suppressions? Do not enable cold — follow
[onboarding an existing codebase](docs/guides/onboarding-existing-codebase.md) so existing
debt grandfathers instead of blocking.

## Commands

```sh
pocket-zipper check --base <ref> [--json <path>] [--verbose]   # authoritative CI gate
pocket-zipper pre-commit [--json <path>] [--verbose]           # staged index, local feedback
```

`--json <path>` writes the versioned evaluation record; stdout stays for the human report.

## Documentation

- **[Guides](docs/guides/README.md)** — task-oriented, start here:
  [quick start](docs/guides/quick-start.md),
  [onboarding an existing codebase](docs/guides/onboarding-existing-codebase.md),
  [handling a failure](docs/guides/handling-a-failure.md),
  [pre-commit hook](docs/guides/pre-commit.md),
  [troubleshooting](docs/guides/troubleshooting.md).
- **CI quick-starts** — copy-paste setup that links to the deep reference:
  [GitHub Actions](docs/guides/ci/github.md),
  [GitLab CI/CD](docs/guides/ci/gitlab.md),
  [Bitbucket Cloud](docs/guides/ci/bitbucket.md).
- **[CI reference](docs/ci/principles.md)** — the host-semantics ground rules, plus
  [GitHub](docs/ci/github.md), [GitLab](docs/ci/gitlab.md), and
  [Bitbucket](docs/ci/bitbucket.md) pages with example files.

Two rules are load-bearing enough to state here:

- **The effective policy is always the baseline's.** A head-side edit to
  `.pocket-zipper/config.yml` or `.pocket-zipper/exceptions.yml` never shapes its own
  evaluation; it takes effect from the next one (one-merge lag).
- **Protect `.pocket-zipper/**`.** Keep the policy and exception registry mergeable only
  through approved policy PRs (required reviewers or CODEOWNERS), or the exception
  registry is toothless. See
  [CI wiring principles §5](docs/ci/principles.md#5-the-pocket-zipper-protection-prerequisite).

## Requirements

- Node.js 20 or newer.
- `git` 2.43 or newer, with a full clone. Shallow clones are auto-unshallowed when
  possible; partial (promisor) clones fail closed.
- ESLint 8 or newer, installed and configured. No `user.name`/`user.email` is required.

## Development

```sh
npm install
npm run typecheck
npm test          # builds, then runs the CLI-seam suite against real git + ESLint
```

## Out of scope

Hosted service/dashboard, Git-host API calls inside the core, automatic remediation or
approval, notifications, IDE integration, organization-wide suppression management,
signed releases, manually maintained baseline inventories, per-file governance, and
governance of ESLint's bulk-suppressions file (`eslint-suppressions.json`).
