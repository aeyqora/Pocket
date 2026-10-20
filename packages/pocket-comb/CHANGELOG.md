# Changelog

All notable changes to `pocket-comb` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-20

The first release: six mass ESLint suppression-directive operations over a
config-isolated ESLint instance, a persistent worker pool, and hand-rolled reports.

### Added

- **Package and CLI** — the six verbs (`suppress`, `fix`, `remove`, `replace`,
  `cleanup`, `inventory`), the full flag table, `--help` / `--version`, and the
  exit-code contract (0 success, 1 dry-run impact, 2 operational error). The
  non-interactive default is a dry run; a TTY with gaps enters the wizard.
- **Action-config loader** — a standard ESLint flat config plus the namespaced
  `settings["pocket-comb"]` block (`target`, `replace`, `report`), label precedence
  (flag > wizard answer > settings > default), the path-resolution rules (relative
  `settings.target` resolves against the config file's directory), auto-detection of
  `pocket-comb.config.{js,mjs,cjs,json}` in the cwd, and the config sha256 carried
  into every report.
- **Discovery and the isolated ESLint instance** — a tool-owned tinyglobby walk
  honoring `.gitignore` plus hardcoded skips (`node_modules`, `.git`, `dist`,
  dot-directories) and the extension filter; linting under `overrideConfigFile` with
  `cwd` = the resolved target root, so the target repo's own `eslint.config.*` is
  never read. Dropped files are detected and classified (ignored / unconfigured /
  external), synthetic ignored-file warnings are filtered, both warn and error
  severities are actionable, and unparsable files are reported and skipped rather
  than crashing the run.
- **Persistent worker pool and run UX** — one ESLint instance per worker constructed
  at boot and reused across batches, default `ceil(cores × 0.75)` (min 1) with
  `--workers`, `--serial`, and `--batch-size` (default 16); a crashed worker's chunk
  re-runs once in-process, a second failure exits 2 with the partial state reported.
  A hand-rolled main-thread spinner that cannot freeze, and the completion
  confirmation line.
- **`suppress`** — the flagship: for every actionable message (both severities,
  per-line aggregation) insert `// eslint-disable-next-line <rules>` directly above
  the violation (indent-matched) or prepend the rule onto an existing directive's
  list (position 0, order and trailing `-- description` preserved). The guard order
  is `line`-form then `next-line`-form; bare and already-guarded directives are
  skipped, never rewritten. Violations inside a `block` span or under a `file-level`
  directive get a precise minimal-span insert. `--reason <text>` appends
  ` -- text` to inserted directives only; `--fix-first` autofixes, re-lints from
  disk, then suppresses the remainder; `--reuse-blocks` prepends onto the enclosing
  block/file-level guard instead of the minimal-span insert.
- **`fix`** — autofix the action config's rules under the isolated instance, writing
  via `ESLint.outputFixes`; a dry run reports the would-fix impact and never writes
  (convergence is ESLint's internal 10-pass loop).
- **`remove`** — strip the action config's rules from every directive list across all
  four forms; a directive whose list empties is deleted entirely (a bare
  `eslint-disable` is never produced), a paired `eslint-enable` is removed when its
  block-open empties (both ledgered), and bare directives are left untouched and
  reported as not-actionable. Built on the shared full-file directive scan.
- **`replace`** — rename rule tokens across every directive, exact token match by
  default; a `--from` ending in `/` re-points every rule token under that prefix
  (plugin migrations). Pair precedence is `--from`/`--to` flags over
  `settings.replace`; a missing pair in a non-TTY run exits 2. Bare directives are
  untouched, and a rename adds the follow-on hint to run `cleanup`.
- **`cleanup`** — prune unused suppression directives from ESLint's always-on
  `reportUnusedDisableDirectives` reporting, config-scoped so only the action config's
  rules are stripped. Multi-rule directives are edited surgically, emptied comments
  are deleted whole, and unused `eslint-enable` directives are removed whole. Every
  removal lands in the edit ledger.
- **`inventory`** — the read-only census: a full-file scan counting every directive
  across all four forms, per `(form, rule)` and per file (bare per form), with stable
  ordering so successive censuses diff cleanly over time. No lint pass, so it is the
  fastest action and succeeds on files ESLint could not parse.
- **Reports** — hand-rolled JSON (canonical), CSV (flat ledger, RFC-4180 quoted), and
  HTML (single self-contained file, inline CSS, no external assets or required JS,
  per-file `<details>` drill-down) renderers, wired into every action. JSON carries
  the run metadata, the edit ledger, and by-rule / by-form / by-file rollups; the
  census replaces the ledger with totals. `--format csv|json|html` (default html),
  `--out <path|->` (default `pocket-comb-report.<ext>` in the cwd, clobbered per run;
  `-` streams to stdout), and `--no-report`.
- **The wizard** — a gap-only interactive session over `@clack/prompts` for TTY runs:
  the action select, the config path prompt (pre-filled from auto-detection,
  validated), the target path prompt (`directory: true`, cwd default, relative paths
  preserved), the replace pair when neither flags nor settings carry it, the
  dry-run/apply confirmation (skipped for `inventory` and when already answered), and
  the report prompt when neither settings nor flags carry it. After a dry run:
  apply / restart / abort. Every prompt is bypassed by its flag twin; a non-TTY run
  never prompts.
- **Performance harness** — a committed deterministic corpus generator packing every
  directive shape, a separate `test:perf` timing suite (warmup + 5 runs, medians per
  action and per stage), and a platform-keyed committed baseline with a ×1.15 gate
  and `--update-baseline` re-pinning. Deliberately excluded from `npm test`.
- **Pack smoke test** (`npm run test:pack`) — packs the built package, inspects the
  tarball, installs it (with the `eslint` peer) into a scratch repo outside the
  package, and drives the installed bin through a `suppress` dry run and an
  `inventory` census end to end.
-  **Documentation** — wizard-first guides, configuration guide, action guide, examples, and full reference, included in the npm package.

[0.1.0]: https://github.com/aeyqora/Pocket/commits/main/packages/pocket-comb
