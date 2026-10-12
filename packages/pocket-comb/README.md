# pocket-comb

Mass ESLint suppression-directive operations — `suppress`, `fix`, `remove`,
`replace`, `cleanup`, and `inventory` — against a config-isolated ESLint
instance.

The acting counterpart to pocket-zipper: the zipper gates new suppression debt;
the comb performs the mass operations the gate's trends justify.

Status: early scaffold. The CLI surface and action-config loader land first; the
actions, pool, engine, reports, and wizard follow. See `CONTEXT.md` for the
shared vocabulary and `.scratch/pocket-comb/spec.md` for the specification.

## Usage

```
npx pocket-comb <action> [flags]

actions: suppress | fix | remove | replace | cleanup | inventory
```

The action config is a standard ESLint flat config plus a namespaced
`settings["pocket-comb"]` tool block. Auto-detected from the cwd as
`pocket-comb.config.{js,mjs,cjs,json}` when `--config` is not given.

## Development

```
npm run build        # tsc -> dist
npm run typecheck    # tsc --noEmit
npm test             # fast correctness only (build + node:test)
```

### Performance harness

The deterioration tripwire (spec §11) is a **separate** timing suite:

```
npm run test:perf                     # measure vs the committed baseline
npm run test:perf -- --update-baseline   # deliberately re-pin this platform
```

**Run it before merging feature work**, on an otherwise idle machine. It is
deliberately excluded from `npm test` (timing flake does not belong in the
correctness loop). See [`perf/README.md`](perf/README.md) for the corpus, the
methodology, the platform-keyed baseline, and the gate floor.
