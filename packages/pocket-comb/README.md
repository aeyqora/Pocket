# Pocket Comb

A fast, lightweight CLI for mass ESLint suppression-directive operations across large
repos. Six first-class actions — `suppress` (the flagship: mass-insert / prepend disable
comments), `fix`, `remove`, `replace`, `cleanup`, and `inventory` — run against a
**standalone ESLint instance** driven only by your action config. Your repository's own
ESLint config is never read. Every mutating run reports its impact in a dry run before it
writes anything.

It is the acting counterpart to Pocket Zipper: the zipper gates new suppression debt; the
comb performs the mass operations the gate's trends justify. Both warn and error
severities are actionable, and edits are inline and line-anchored — unlike ESLint's own
errors-only bulk suppressions.

## Documentation

- **[Start here: the wizard](docs/README.md)** — the guided flow, prompt by prompt.
- **[Configuration](docs/configuration.md)** — the one action config every action shares.
- **[Actions](docs/actions.md)** — what each verb does, what it changes, and what outcome
  to expect.
- **[Examples](docs/examples.md)** — wizard sessions and before/after deltas.
- **[Reference](docs/reference.md)** — every flag, exit code, report field, and exported
  function.

## Install

```sh
# Recommended: no install, always the latest release.
npx pocket-comb@latest

# Version-pinned teams:
npm install --save-dev pocket-comb
npx pocket-comb
```

Pocket Comb requires **Node.js 20.12 or newer** and **ESLint 9.34 or newer** (flat config
only). ESLint is a required peer dependency — npm 7+ installs it automatically when you
install Pocket Comb, and `npx` resolves it for you.

## Quick start

```sh
# 1. Write an action config: a standard ESLint flat config.
cat > pocket-comb.config.js <<'EOF'
export default [
  {
    rules: {
      "no-console": "warn",
    },
  },
];
EOF

# 2. Start the wizard.
npx pocket-comb@latest
```

The wizard asks only a few questions:

1. **Which action?** — choose `suppress`.
2. **Action config** — press Enter to accept `./pocket-comb.config.js`.
3. **Target directory** — press Enter to accept the current directory.
4. **Apply changes?** — press Enter for **No**, a dry run.
5. Review the impact, then accept the report format and output prompts.
6. Choose **Apply now** to write it.

That is the whole first run. You can also preselect the action and keep the rest of the
wizard:

```sh
npx pocket-comb@latest suppress
```

A non-interactive run never prompts. It defaults to a dry run and uses flags, settings,
and defaults only. See the [reference](docs/reference.md#flags) for the full flag surface.

The examples use `.js` with ESM `export default`, assuming the package is
`"type": "module"`. In a CommonJS package, use `.mjs` or write `module.exports = [...]`.
See the [config guide](docs/configuration.md#esm-and-commonjs).

## Actions

| Action | Wizard hint | What it does | Changes |
|---|---|---|---|
| `suppress` | insert/prepend disable directives | Insert or prepend directives for the config's rules. | Directive comments |
| `fix` | autofix the config's rules | Autofix the config's rules under the isolated instance. | Source code |
| `remove` | strip the config's rules from directives | Strip the config's rules from every directive. | Directive comments |
| `replace` | rename rule tokens | Rename rule tokens across every directive. | Directive comments |
| `cleanup` | prune unused directives | Prune unused directives, config-scoped. | Directive comments |
| `inventory` | read-only census | Count every **disable** directive, by form, rule, and file. | Nothing |

Each action is described in detail in [Actions](docs/actions.md).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success: an apply completed, or a dry run found no impact. |
| 1 | Dry run with impact — the CI probe. |
| 2 | Operational error: config missing or unloadable, no files matched, invalid input, unrecoverable worker failure. |

## Shortcuts and CI

Every wizard answer has a flag twin. Use them when you want a repeat run, a script, or CI:

```sh
# Non-interactive dry run, then apply.
npx pocket-comb suppress --config ./pocket-comb.config.js
npx pocket-comb suppress --config ./pocket-comb.config.js --apply

# Pipe a census to a trend store.
npx pocket-comb inventory --format csv --out - >> suppressions.csv
```

The complete option list, applicability rules, report destinations, and worker settings
are in the [CLI reference](docs/reference.md#flags). The wizard remains the normal path.

## The action config

The action config is a **standard ESLint flat config** — an array of objects loadable via
`overrideConfigFile` and hand-testable with `eslint -c <path>`. Every field maps natively:

- **Rules to act on** → `rules`. Severity is membership: `warn` and `error` (and `1` / `2`)
  are action targets and behave identically; `"off"` is excluded.
- **Include / exclude filters** → `files` / `ignores` globs.
- **Parser wiring** (TS/JSX) → `languageOptions`.
- **Tool knobs** → the namespaced, free-form `settings["pocket-comb"]` block.

```js
// pocket-comb.config.js
import tseslint from "typescript-eslint"; // resolves from THIS file's node_modules

export default tseslint.config(
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-console": "warn",
      "@typescript-eslint/no-explicit-any": "error",
    },
    settings: {
      "pocket-comb": {
        target: "../apps/web", // relative paths resolve against THIS file's directory
        replace: { from: "jsx-autofocus", to: "jsx-a11y/autofocus" },
        report: { format: "html", out: "comb-report.html" },
      },
    },
  },
);
```

The wizard asks for the config path and pre-fills the detected file. Full details, path
rules, and recipes: [Configuration](docs/configuration.md).

### `settings["pocket-comb"]`

| Key | Type | Meaning |
|---|---|---|
| `target` | string | Target root. Relative paths resolve against the config file's directory. Answers the wizard's target prompt. |
| `replace` | `{ from, to }` | The `replace` action's rename pair. Answers the wizard's rename prompts. |
| `report` | `{ format, out }` | Report format (`csv` / `json` / `html`) and destination. Skips the wizard's report prompts. |

### Config coverage for non-JS targets

ESLint only lints JavaScript-family files unless a config object's `files` names another
extension. A discovered file that no config object covers is **dropped as "unconfigured"**
and never reaches the action. So for a TypeScript, TSX, or JSX target you must add
matching `files` coverage *and* the parser:

```js
{
  files: ["**/*.ts", "**/*.tsx"], // without this, .ts / .tsx files are dropped
  languageOptions: { parser: tseslint.parser },
  rules: { "@typescript-eslint/no-explicit-any": "error" },
}
```

Dropped files are counted in the report's `counts.dropped`; they are never silently
misreported as clean.

### TypeScript configs

The config file may be `.js`, `.mjs`, `.cjs`, or `.json`. A **TypeScript** config
(`pocket-comb.config.ts`) is not auto-detected; type its path at the wizard's config
prompt. It is loaded through Node's ESM loader, so the runtime must be able to import
TypeScript — Node 22.18+ supports this natively; older versions need a loader.

### Path resolution

- A relative config or target answer resolves against the **cwd**.
- A relative `settings.target` resolves against the **config file's directory**, so a
  tools-directory config can target a repo path elsewhere.
- ESLint's `cwd` is the resolved target root, so the config's `files` / `ignores` globs
  resolve against the target, never the config's own location.

## Reports

The wizard asks for the report format and destination after the run, unless a setting or
flag already answers it. `html` is the default; `csv` is the flat ledger; `json` is the
canonical schema. The report is written last, after the impact and completion lines.

`inventory` renders a census instead. It counts **disable** directives only — the four
suppression forms (`next-line`, `line`, `block`, `file-level`). An `eslint-enable` is a
block closer, not a suppression, so it is excluded from census totals and per-file counts.

For report flags, destinations, and schema, see the
[reference](docs/reference.md#reports).

## Requirements

- **Node.js** 20.12 or newer.
- **ESLint** 9.34 or newer, flat config only. A required peer dependency.

## Development

```sh
npm install
npm run build        # tsc -> dist
npm run typecheck    # tsc --noEmit
npm test             # fast correctness suite (build + node:test)
```

`npm test` runs `test/*.test.ts` (one level) **deliberately**: `test/perf/**` is the
perf-harness suite, kept out of the fast correctness loop and run by
`npm run test:perf:harness`.

### Pack smoke test

```sh
npm run test:pack    # build, npm pack, install the tarball in a scratch repo, run it
```

It inspects the packed tarball, installs it (with the ESLint peer) into a scratch repo
outside this package, and drives the installed bin through a `suppress` dry run and an
`inventory` census. It is kept out of `npm test` because it shells out to npm and needs the
registry for the peer.

### Performance harness

The deterioration tripwire (spec §11) is a separate timing suite:

```sh
npm run test:perf                        # measure against the committed baseline
npm run test:perf -- --update-baseline   # deliberately re-pin this platform
```

Run it before merging feature work, on an otherwise idle machine. It is deliberately
excluded from `npm test` (timing flake does not belong in the correctness loop). See
[`perf/README.md`](perf/README.md) for the corpus, the methodology, the platform-keyed
baseline, and the per-stage gate.
