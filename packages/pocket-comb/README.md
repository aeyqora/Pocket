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

## Install

```sh
# Recommended: no install, always the latest release.
npx pocket-comb@latest <action>

# Version-pinned teams:
npm install --save-dev pocket-comb
npx pocket-comb <action>
```

Pocket Comb requires **Node.js 20.12 or newer** and **ESLint 9.34 or newer** (flat config
only). ESLint is a required peer dependency — npm 7+ installs it automatically when you
install Pocket Comb, and `npx` resolves it for you.

## Quick start

```sh
# 1. Write an action config: a standard ESLint flat config.
cat > pocket-comb.config.mjs <<'EOF'
export default [
  {
    rules: {
      "no-console": "warn",
    },
  },
];
EOF

# 2. Dry run — prints the impact and writes nothing.
#    Exit 1 when there is impact (the CI probe), 0 when there is none.
npx pocket-comb@latest suppress --config ./pocket-comb.config.mjs

# 3. Apply — writes the directives.
npx pocket-comb@latest suppress --config ./pocket-comb.config.mjs --apply
```

With no `--config`, Pocket Comb auto-detects `pocket-comb.config.{js,mjs,cjs,json}` in the
current directory. On a terminal it fills any remaining gaps with a wizard; a
non-interactive run uses flags only and never prompts a pipe.

## Actions

| Action | What it does |
|---|---|
| `suppress` | The flagship. Insert or prepend disable directives for the config's rules, one directive per line. Flags: `--reason <text>`, `--fix-first`, `--reuse-blocks`. |
| `fix` | Autofix the config's rules under the isolated instance. |
| `remove` | Strip the config's rules from every directive in the target. |
| `replace` | Rename rule tokens across every directive. `--from <rule>` / `--to <rule>`; a `--from` ending in `/` re-points every rule under that prefix. |
| `cleanup` | Prune unused directives (config-scoped). |
| `inventory` | The read-only census: count every directive, by form, rule, and file. No linting. |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success: an apply completed, or a dry run found no impact. |
| 1 | Dry run with impact — the CI probe. |
| 2 | Operational error: config missing or unloadable, no files matched, invalid input, unrecoverable worker failure. |

### Flags

| Flag | Applies to | Meaning / default |
|---|---|---|
| `-c, --config <path>` | all | Action config; auto-detected from the cwd convention. |
| `-t, --target <path\|glob>` | all | Target root; default cwd (after `settings.target`). |
| `--dry-run` / `--apply` | mutating | Non-interactive default is a dry run; `--apply` writes. |
| `--from <rule>` / `--to <rule>` | replace | The rename pair; overrides `settings.replace`. |
| `--reason <text>` | suppress | Append ` -- text` to inserted directives only. |
| `--fix-first` | suppress | Autofix first, re-lint, then suppress the remainder. |
| `--reuse-blocks` | suppress | Prepend into enclosing block/file-level guards. |
| `--format csv\|json\|html` | all | Report format; default `html`. |
| `--out <path\|->` | all | Report destination; default `pocket-comb-report.<ext>` in cwd; `-` is stdout. |
| `--no-report` | all | Skip the report. |
| `--workers <n>` | all | Pool size; default `ceil(cores × 0.75)`, min 1. |
| `--serial` | all | No pool; a single in-process instance. |
| `--batch-size <n>` | all | Files per task; default 16. |
| `--extensions <csv>` | all | Discovery extensions; default `.js,.mjs,.cjs,.jsx,.ts,.mts,.cts,.tsx`. |
| `--version`, `--help` | — | Print and exit 0. |

## The action config

The action config is a **standard ESLint flat config** — an array of objects loadable via
`overrideConfigFile` and hand-testable with `eslint -c <path>`. Every field maps natively:

- **Rules to act on** → `rules`. Severity is membership: `warn` and `error` (and `1` / `2`)
  are action targets and behave identically; `"off"` is excluded.
- **Include / exclude filters** → `files` / `ignores` globs.
- **Parser wiring** (TS/JSX) → `languageOptions`.
- **Tool knobs** → the namespaced, free-form `settings["pocket-comb"]` block.

```js
// pocket-comb.config.mjs
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

### `settings["pocket-comb"]`

| Key | Type | Meaning |
|---|---|---|
| `target` | string | Target root. A relative path resolves against the **config file's directory**, not the cwd. |
| `replace` | `{ from, to }` | The `replace` action's rename pair. |
| `report` | `{ format, out }` | Post-run report format (`csv` / `json` / `html`) and destination; suppresses the report prompt. |

Precedence everywhere is **CLI flag > wizard answer > settings key > default**. Define the
block once; settings across config objects are merged shallowly per key.

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

### TypeScript configs need jiti

The config file may be `.js`, `.mjs`, `.cjs`, or `.json`. A **TypeScript** config
(`pocket-comb.config.ts`) requires a user-installed `jiti >= 2.2` — ESLint's own rule for
loading TypeScript config files. Install it in the repo alongside ESLint:

```sh
npm install --save-dev jiti
```

### Path resolution

- A relative `--config` / `--target` resolves against the **cwd**.
- A relative `settings.target` resolves against the **config file's directory**, so a
  tools-directory config can target a repo path elsewhere.
- ESLint's `cwd` is the resolved target root, so the config's `files` / `ignores` globs
  resolve against the target, never the config's own location.

## Reports

Every action can emit a report: `--format csv|json|html` (default `html`),
`--out <path|->` (default `pocket-comb-report.<ext>` in the cwd; `-` is stdout), or
`--no-report`. JSON is the canonical schema: run metadata (including the config's sha256),
the per-edit ledger, and rollups by rule, form, and file. `inventory` renders a census
instead. The piping shape for a trend store:

```sh
npx pocket-comb inventory --format csv --out - >> suppressions.csv
```

## Requirements

- **Node.js** 20.12 or newer.
- **ESLint** 9.34 or newer, flat config only. A required peer dependency.
- **jiti** 2.2 or newer, only when the action config is TypeScript.

## Development

```sh
npm install
npm run build        # tsc -> dist
npm run typecheck    # tsc --noEmit
npm test             # fast correctness suite (build + node:test)
```

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
baseline, and the gate floor.
