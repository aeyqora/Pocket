# Pocket Lock

Pocket Lock is a CLI that gates a proposed change from adding new ESLint
suppression debt. It inventories the ESLint suppression state of a git-derived
baseline and of the proposed change, reconciles them as *logical suppressions*
(never emitted lint diagnostics), and fails the change when it introduces *new*
or *materially-changed* suppression debt of a governed rule that no valid
*exception* covers.

Vocabulary and the full design live in `CONTEXT.md` and
`.scratch/pocket-lock/spec.md`.

## Install

```sh
npm install --save-dev pocket-lock eslint
```

Pocket Lock is a plain-git, Git-host-agnostic Node.js package. Its only runtime
inputs are the repository's installed ESLint (the semantic authority), the `git`
binary, and a YAML parser (`yaml`). There is no hosted service and no committed
baseline manifest: the baseline is recomputed from git on every run.

The package ships a `pocket-lock` binary:

```sh
pocket-lock check --base <target-ref> [--json <path>] [--verbose]
pocket-lock pre-commit [--json <path>] [--verbose]
```

- `check` is the authoritative CI gate.
- `pre-commit` is early feedback only; it evaluates the staged index.
- `--json <path>` writes the evaluation record; stdout stays reserved for the
  human report.

## Policy

`.pocket-lock/config.yml` (protected; see Branch protection):

```yaml
enabled: true          # optional, default true
governedRules:         # optional allowlist of exact rule ids
  - no-console
  - jsx-a11y/no-autofocus
```

- Absent file = govern every applicable rule, enabled.
- `governedRules` is an allowlist intersected with the rules ESLint's effective
  configuration makes applicable. Nothing about an ungoverned rule is counted,
  reported, or matched.
- An allowlist entry naming a rule ESLint does not recognize fails closed
  (`CONFIG_ERROR`, exit 2). A recognized-but-currently-inapplicable rule is a
  forward declaration, not an error.
- `enabled: false` exits 0, evaluates nothing, and skips policy validation.
- The **effective policy is always the baseline's.** A head-side edit to
  `config.yml` never shapes the current evaluation; it is a policy-change signal
  and takes effect from the next evaluation (one-merge lag).

## Exceptions

`.pocket-lock/exceptions.yml` (protected), one record per logical suppression:

```yaml
- rule: jsx-a11y/no-autofocus
  suppression_type: next-line   # next-line | line | block | file-level directive
  fingerprint: v1:sha256:…      # primary match key
  file: src/components/Search.tsx
  type: temporary               # temporary | permanent
  reason: Autofocus is required for the primary search workflow.
  owner: "@search-team"
  reference: "https://example/issues/123"
  expires: 2026-10-31           # required iff type: temporary (UTC, end-of-day)
```

- Matching is by `fingerprint` + `suppression_type` + `rule` — never line
  numbers. The `file` field is verification only; a mismatch fails closed.
- Exceptions are read from the baseline registry. An exception committed in the
  same change authorizes nothing for that change (two-step landing: land the
  exception in a protected policy PR, then land the suppression in a later
  ordinary PR).
- Temporary exceptions are valid through the end of their UTC date; once past,
  they authorize nothing and the suppression reads as unexcepted new debt.
- `reason`, `owner`, and `reference` are required; `expires` only for temporary.
- Unused exceptions — *dangling* (matches nothing) and *spent* (its suppression
  became existing debt) — are reported as cleanup debt and never fail the gate.
- Config-level `off` suppressions are **not** exceptable via the registry; they
  are a policy change.

## CI wiring

This snippet is the GitHub Actions quick-start. The full reference lives in
[`docs/ci/`](docs/ci/): a host-agnostic [principles](docs/ci/principles.md) page plus
one [GitHub Actions](docs/ci/github.md), [GitLab CI/CD](docs/ci/gitlab.md), and
[Bitbucket Cloud](docs/ci/bitbucket.md) page, each with a copy-paste example.

Run the authoritative check on a full-depth checkout:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0            # Pocket Lock needs real history
- run: npm ci
- run: npx pocket-lock check --base origin/main --json pocket-lock.json
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: pocket-lock-record
    path: pocket-lock.json
```

- The evaluation record is the statistics artifact; CI persists it to the
  host's artifact store. Pocket Lock writes nothing to the working tree.
- In CI, when the host supplies a **merge result** (HEAD is a merge commit), the
  proposed change is that merge result and the baseline is its **first parent**
  — the current target tip. Otherwise the baseline is the computed merge-base of
  the resolved `--base` ref and HEAD. A naive two-point diff is never used.
- Full history is required. Shallow clones are unshallowed automatically and
  fail closed if that is not possible; partial (promisor) clones fail closed.

### Branch protection

Make the protected configuration space — `.pocket-lock/config.yml` and
`.pocket-lock/exceptions.yml` — mergeable only through approved policy PRs
(required reviewers / code owners on `.pocket-lock/**`). This is where human
approval is counted: the core is host-agnostic and never reads reviewers. A
policy-weakening edit *consumed by new debt in the same change* fails the gate
(`POLICY_CHANGE`, exit 1); a pure policy edit is recorded but not gate-failed.
Without branch protection the exception registry is toothless.

## Onboarding an existing codebase

1. Land `.pocket-lock/config.yml` with `enabled: false` in a protected policy PR.
2. Mass-suppress the rules you intend to govern in ordinary PRs — the gate is
   off, so there is no pressure.
3. Flip `enabled: true` in a protected policy PR. It is evaluated under the old
   (disabled) policy, so every suppression already present grandfathers as
   existing debt.
4. Optionally narrow to a `governedRules` allowlist and widen it over time.

## Pre-commit hook

```sh
npx pocket-lock pre-commit
```

- Evaluates the **staged index only**; unstaged worktree edits are ignored.
- Silent on pass unless `--verbose`; loud on failure.
- Early feedback only — the CI check is authoritative.

## Output and exit codes

| Exit | Meaning |
|---|---|
| `0` | pass (or `enabled: false` exclusion) |
| `1` | gate failure: unauthorized new / materially-changed governed debt, or `POLICY_CHANGE` self-authorization |
| `2` | operational fail-closed: `GIT_ERROR`, `ESLINT_ERROR`, `CONFIG_ERROR`, `INTERNAL_ERROR` |

On failure the human report prints one verdict line, per-disposition counts, and
a per-file listing of only NEW and MATERIALLY-CHANGED governed suppressions with
a copy-paste-ready exception record for each. Colors are used only when stdout
is a TTY. Granular reasons travel in the record's `errors[]`, never in the exit
code. The record is versioned (`schemaVersion: 1`) and carries both compared tree
ids for reproducibility.

## Environment pins

- git ≥ 2.43 (or the explicit `$(git merge-base A B)` spelling on older git).
- Rename detection (`-M`) and NUL-delimited name output (`-z`) are spelled
  explicitly by the tool.
- Requires a full clone; no `user.name`/`user.email` is needed.

## Development

```sh
npm install
npm run typecheck
npm test          # builds, then runs the CLI-seam suite against real git + ESLint
```

## Out of scope

Hosted service/dashboard, Git-host API calls inside the core, automatic
remediation or approval, notifications, IDE integration, organization-wide
suppression management, signed releases, manually maintained baseline
inventories, per-file governance, and governance of ESLint's bulk-suppressions
file (`eslint-suppressions.json`).
