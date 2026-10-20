# Performance harness

The deterioration tripwire (spec §11). Dev-only pieces (none are shipped):

- **`generate.ts`** — the committed, deterministic corpus generator.
- **`run-perf.ts`** — the timing suite, wired to `npm run test:perf`.
- **`baseline.json`** — the committed baseline, keyed by platform.
- **`corpus.config.mjs`** — the isolated action config the corpus is linted with.

## The ritual

> **Run `npm run test:perf` before merging feature work.** That is the contract
> that keeps the engine honest as the codebase grows.

It is deliberately **not** part of `npm test`: timing is noisy, and a flaky gate
in the correctness loop would be muted, not fixed. `npm test` stays fast and
deterministic; `test:perf` is run on its own, on an **otherwise idle machine**.

## Running

```sh
npm run test:perf                 # measure default (2,000) + stress (20,000)
npm run test:perf -- --scales default
npm run test:perf -- --files 500  # a one-off custom scale
POCKET_COMB_PERF_STRESS_FILES=50000 npm run test:perf -- --scales stress
```

The suite warms each stage up, takes measured runs, and reports the median per
stage. It fails when **any** stage's **minimum across runs** exceeds the
committed baseline for this platform by more than ×1.15 (`--threshold`). No stage
is exempt.

### Re-pinning a baseline

Baselines are keyed by **`os` + CPU model + Node version**; a different machine
simply has no entry and the run reports that (exit 0) unless `--require-baseline`.
Re-pin only when a change is a *deliberate* performance shift:

```sh
npm run test:perf -- --update-baseline            # this platform, both scales
```

Commit the resulting `baseline.json` diff with the change that justified it.

## Methodology

- **Corpus**: 2,000 files by default (`POCKET_COMB_PERF_STRESS_FILES` / `--files`
  for other sizes; `--scales stress` uses 20,000). Same seed ⇒ byte-identical
  corpus, so statistics compare like for like. The corpus is generated into the
  OS temp dir, not the repo — discovery honours `.gitignore`, so a corpus under a
  gitignored path would measure zero files.
- **Runs**: warmup (default 10) then 15 measured runs; the **median** is
  reported, and the **minimum across the runs** is what the gate compares. Ten
  warmups are needed because the cheapest stage (`discover`) walks in ~5 ms and a
  cold filesystem cache makes the first several walks much slower; ten settles it
  to a ±3% band across fresh processes. Fifteen runs give the minimum a good
  chance of catching the stage's uncontended cost. Pinning uses the same 15 runs
  so a baseline and a comparison sample identically (`--runs` overrides both).
- **One execution per sample, GC first**: each measured sample is a single
  execution of the stage, immediately preceded by a forced garbage collection
  (`npm run test:perf` runs Node with `--expose-gc`; the harness calls
  `global.gc()`). Single executions keep the allocation-heavy stages from paying
  GCs they would not pay in production — a calibrated repeat loop was tried first
  and rejected, because it manufactures exactly the GC pressure it then
  attributes to the stage.
- **Gate on the minimum**: the gate compares the minimum across runs, not the
  median. At the 2,000-file default the post-lint stages are 0.3–10 ms, and on a
  shared machine the median swings 20–30% from process to process (background
  Spotlight indexing, browsers, other jobs) — no ±15% median gate is stable
  there. The minimum is the least-contended sample, so it estimates the stage's
  real cost and holds steady; a genuine regression raises the minimum too (the
  injected-slowdown test in `test/perf/run-perf.test.ts` proves it). The median
  is still reported next to it, and every stage is gated — none is exempt.
- **Scales**: `default` (2,000) and `stress` (20,000; override with
  `POCKET_COMB_PERF_STRESS_FILES` or pick an ad-hoc size with `--files`).
- **Stages** (spec §11): `discover`, `lint`, `scan`, `plan`, `apply`,
  `scan-full`, `report`, then one `action:<verb>` stage per action
  (`suppress`, `remove`, `replace`, `cleanup`, `inventory`). The engine and
  `action:*` stages consume the lint stage's recorded messages and the memoized
  file text — no pool construction and **no re-lint** — so they measure engine
  time only; each reports a µs/file micro-timing (per the files with messages for
  the suppress hot path, per corpus file for the full-file scan and the
  scan-based actions). `report` assembles and renders the run report (HTML, the
  default format).

## Corpus shapes

`generate.ts` packs every hot-path shape (asserted in
`test/perf/generate.test.ts`): clean files, sparse and dense violations, all four
directive forms (`next-line`, `line`, `block`, `file-level`), bare guards,
multi-rule lists, `-- description` suffixes, block pairs with their
`eslint-enable`, CRLF line endings, a BOM, and long lines.

## Census scope (deliberate)

The census (`inventory`) counts **disable** directives only — the spec's "all
four forms" (`next-line`, `line`, `block`, `file-level`). `eslint-enable` closers
are not a suppression form, so they are excluded from the census totals and
per-file counts. See `src/census.ts` and the package README.
