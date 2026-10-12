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
- `inventory`: the read-only census (spec §6.6) — a full-file scan counting every
  suppression directive across all four forms, per `(form, rule)` and per file
  (bare per form), with stable ordering for clean diffs over time. No lint pass;
  renders in all three report formats.

[Unreleased]: https://github.com/aeyqora/Pocket/commits/main/packages/pocket-comb
