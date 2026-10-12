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
