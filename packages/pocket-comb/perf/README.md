# Performance harness

The deterioration tripwire (spec §11). Two pieces, both dev-only (not shipped):

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
```

The suite warms each stage up, takes 5 measured runs, and reports the median per
stage. It fails when a gated stage's median exceeds the committed baseline for
this platform by more than ×1.15 (`--threshold`).

### Re-pinning a baseline

Baselines are keyed by **`os` + CPU model + Node version**; a different machine
simply has no entry and the run reports that (exit 0) unless `--require-baseline`.
Re-pin only when a change is a *deliberate* performance shift:

```sh
npm run test:perf -- --update-baseline            # this platform, both scales
```

Commit the resulting `baseline.json` diff with the change that justified it.

## Methodology

- **Corpus**: 2,000 files by default (`--stress` / `--files 20000` for the stress
  scale). Same seed ⇒ byte-identical corpus, so medians compare like for like.
  The corpus is generated into the OS temp dir, not the repo — discovery honours
  `.gitignore`, so a corpus under a gitignored path would measure zero files.
- **Runs**: warmup (default 5) then 5 measured runs; the **median** is reported.
  The spec pins only "after warmup"; 5 warmups were chosen because the pool
  rebuilds its workers every measured run, and a cold first process inflated the
  first stage's median past 1.15 (~28% spread at 3 warmups vs ~7% at 5).
  `--update-baseline` deliberately uses **15** measured runs, so the committed
  reference is a central estimate rather than one noisy sample (`--runs`
  overrides both).
- **Scales**: `default` (2,000) and `stress` (20,000).
- **Stages**: `discover` and `lint` today. The engine stages (`scan` / `plan` /
  `apply`) append to `createStages()` in `run-perf.ts` (see the marked extension
  point); they consume the lint stage's recorded messages so they measure only
  engine time, and report µs/file micro-timings.

### The gate floor

Stages whose committed baseline is below `MIN_GATED_BASELINE_MS` (10 ms) are
measured and reported but **not gated** (`info` in the output). A ~5 ms walk has
no stable ±15% — the default-scale `discover` stage swung 5.1–6.1 ms across
fresh, idle processes from filesystem/timer jitter alone, and no warmup removed
it. Every larger stage (stress `discover` ~50 ms, `lint` at both scales) is gated
normally.

## Corpus shapes

`generate.ts` packs every hot-path shape (asserted in
`test/perf/generate.test.ts`): clean files, sparse and dense violations, all four
directive forms (`next-line`, `line`, `block`, `file-level`), bare guards,
multi-rule lists, `-- description` suffixes, block pairs with their
`eslint-enable`, CRLF line endings, a BOM, and long lines.
