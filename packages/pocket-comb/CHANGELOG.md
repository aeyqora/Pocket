# Changelog

All notable changes to `pocket-comb` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Package scaffold: build, typecheck, and test scripts (house pattern).
- CLI skeleton: six verbs, the full flag table, `--help` / `--version`, and the
  exit-code contract (0 success, 1 dry-run impact, 2 operational error).
- Action-config loader: flat config plus `settings["pocket-comb"]`, label
  precedence (flag > settings > default), path-resolution rules, and the config
  sha256 for reports.
- Perf harness (spec §11): a committed deterministic corpus generator packing
  every directive shape, a separate `test:perf` timing suite (warmup + 5 runs,
  medians per stage), and a platform-keyed committed baseline with a ×1.15 gate
  and `--update-baseline` re-pinning.
- `fix` action: autofix the action config's rules under the isolated instance,
  writing via `ESLint.outputFixes`; a dry run reports the would-fix impact and
  never writes (convergence is ESLint's internal 10-pass loop).
- `suppress --fix-first`: autofix first, re-lint the fixed files from disk, then
  suppress only the remainder — one ledgered run.
- `suppress --reuse-blocks`: prepend the rule onto the enclosing `block`-open /
  `file-level` directive's list (description preserved) instead of the default
  minimal-span insert.
- `inventory`: the read-only census (spec §6.6) — a full-file scan counting every
  suppression directive across all four forms, per `(form, rule)` and per file
  (bare per form), with stable ordering for clean diffs over time. No lint pass;
  renders in all three report formats.
- `cleanup`: prune unused suppression directives (spec §6.5) from ESLint's default
  `reportUnusedDisableDirectives` reporting — config-scoped, so only the action
  config's rules are stripped; multi-rule directives are edited surgically and
  emptied comments deleted whole; unused `eslint-enable` directives are removed
  whole. Every removal lands in the edit ledger (`prune`).

[Unreleased]: https://github.com/aeyqora/Pocket/commits/main/packages/pocket-comb
