# Configuration

Pocket Comb reads exactly one **action config**. The wizard asks for it, pre-filled with a
config it finds in the current directory. The same file serves every action: there are no
per-action rule lists.

The config is a standard ESLint flat config (array of config objects) plus an optional
namespaced tool block:

- `rules` name the rules an action may touch.
- `files`, `ignores`, and `languageOptions` control what is linted and how.
- `settings["pocket-comb"]` carries Pocket Comb's own knobs: target, replace pair, and
  report destination.

The target repository's own ESLint config is never read. Pocket Comb passes the action
config to ESLint as `overrideConfigFile`, which bypasses config search entirely.

## How the wizard finds the config

When you run `npx pocket-comb`, the **Action config** prompt appears. It is pre-filled with
the first of these files found in the current directory:

1. `pocket-comb.config.js`
2. `pocket-comb.config.mjs`
3. `pocket-comb.config.cjs`
4. `pocket-comb.config.json`

Press Enter to accept the detected file, or type another path. The wizard validates that
the file exists and loads before continuing.

A TypeScript config (`pocket-comb.config.ts`) is **not** auto-detected, so type its path at
the prompt. It needs a Node runtime that can import TypeScript (Node 22.18+ has native type
stripping; older Node versions need a loader).

If you prefer to skip the prompt, `--config <path>` answers it. The flag is documented in
the [reference](reference.md#flags); the wizard path is the normal one.

## Minimal config

```js
// pocket-comb.config.js
export default [
  {
    rules: {
      "no-console": "warn",
      "no-unused-vars": "error",
    },
  },
];
```

This config acts on `no-console` and `no-unused-vars`, and targets the current directory
(it has no `target` setting). Run `npx pocket-comb`, accept this file at the config prompt,
accept the target, and answer No to the apply question.

An equivalent JSON config:

```json
[
  {
    "rules": {
      "no-console": "warn",
      "no-unused-vars": "error"
    }
  }
]
```

A JSON config cannot import parsers or plugins, so it is only useful for rules that ESLint
already provides.

### ESM and CommonJS

The `.js` examples use ESM syntax (`export default`), which assumes the package's
`package.json` has `"type": "module"`. In a CommonJS package, either name the file
`pocket-comb.config.mjs` (ESM regardless of package type), or keep `.js` and write:

```js
module.exports = [
  {
    rules: { "no-console": "warn" },
  },
];
```

`.cjs` also works and is always CommonJS. The config's file extension does not change
which actions are available.

## What the config controls

### Rules: the action targets

`rules` is the action's rule set. Membership is severity:

```js
rules: {
  "no-console": "warn",        // actionable
  "no-debugger": "error",      // actionable
  "eqeqeq": 2,                 // actionable
  "quotes": ["warn", "single"],// actionable (tuple form)
  "no-alert": "off",           // excluded
  "semi": 0,                   // excluded
}
```

- `warn` and `error` are equivalent for every action. Both are actionable.
- `"off"`, `0`, and `[0]` are excluded.
- Rules are collected across every config object, deduplicated, in first-seen order.
- There is no per-action rule list. `suppress` and `cleanup` read the same set, `remove`
  strips the same set, and `fix` autofixes the same set.

#### Why severity?

Severity is not a priority and it is not an action filter. It is how an ESLint flat config
expresses whether a rule is enabled, so every entry needs a valid ESLint severity value.
Pocket Comb reduces that value to one bit: `"off"` means excluded, anything greater than
zero means included. No action distinguishes `"warn"` from `"error"`.

If you do not care about the distinction, use `"warn"` uniformly. Use `"off"` to keep a
rule out of the action set. The config remains a normal ESLint config either way, so
`eslint -c <path>` can still load it.

`inventory` is the exception in effect: it does not lint, so it does not use the rule set.
It still requires a loadable config because target and report settings come from it.

### Files and ignores: what is in scope

`files` and `ignores` use ESLint flat-config glob semantics and resolve against the
**target root**, not the config file's directory.

```js
export default [
  {
    files: ["src/**/*.js", "src/**/*.ts"],
    ignores: ["**/*.test.ts", "generated/**"],
    rules: { "no-console": "warn" },
  },
];
```

Pocket Comb discovers files itself - it does not hand ESLint a glob - but ESLint still
applies the config's `files` / `ignores` to each explicit file. A discovered file that no
config object covers is **dropped as unconfigured** and never reaches the action.

That is the most common configuration mistake: a TypeScript target without `files`
coverage. ESLint only lints JavaScript-family files by default, so a `.ts` object needs
both `files` and a parser:

```js
import tseslint from "typescript-eslint";

export default [
  {
    files: ["**/*.ts", "**/*.tsx"], // REQUIRED: no coverage means dropped, not linted
    languageOptions: { parser: tseslint.parser },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];
```

Dropped files are counted in the report's `meta.counts.dropped`. They are never reported
as clean.

Two other drop reasons are possible:

| Drop kind | Cause |
|---|---|
| `ignored` | The file matches an `ignores` pattern or is ignored by ESLint's own rules. |
| `unconfigured` | No config object's `files` matches the file. |
| `external` | The file is outside the ESLint base path. |

### Parser wiring for TypeScript, JSX, and friends

The action config is an ESLint config, so parsers and plugins are imported normally.
Imports resolve from the config file's own directory, not from the npx cache. That means
a repo's `node_modules` can feed a config that Pocket Comb runs from anywhere.

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
```

`suppress`, `fix`, and `cleanup` need a working parser for the file types they lint.
`remove`, `replace`, and `inventory` operate on directive text and do not need a parse for
their own work, but they still run through the same config and discovery pipeline. A
file ESLint cannot parse is skipped and never treated as clean.

## The `settings["pocket-comb"]` block

Tool settings are namespaced so ESLint ignores them. Define the block in any config
object; the blocks are merged shallowly per key, with later objects winning.

```js
export default [
  {
    rules: { "no-console": "warn" },
    settings: {
      "pocket-comb": {
        target: "../apps/web",
        replace: { from: "jsx-autofocus", to: "jsx-a11y/autofocus" },
        report: { format: "html", out: "comb-report.html" },
      },
    },
  },
];
```

| Key | Type | Used by | Meaning |
|---|---|---|---|
| `target` | string | all actions | Target root. A relative path resolves against the **config file's directory**. Answers the wizard's target prompt. |
| `replace` | `{ from: string, to: string }` | `replace` | Default rename pair. Answers the wizard's two rename prompts. |
| `report` | `{ format: "csv" \| "json" \| "html", out: string }` | all actions | Default report format and destination. Skips the wizard's report prompts. |

Settings are validated when the config loads. A malformed block is an operational error
(exit `2`) with a message naming the key:

- `target` must be a non-empty string.
- `replace.from` and `replace.to` must be non-empty strings.
- `report.format` must be `csv`, `json`, or `html`.
- `report.out` must be a non-empty string.

`target`, `replace`, and `report` are the complete settings surface. There is no setting
for `--reason`, `--fix-first`, `--reuse-blocks`, worker count, or extensions; those are
CLI-only and live in the [reference](reference.md#flags).

## Path resolution

Path resolution is the one place the config's location changes the answer.

| Value | Relative paths resolve against |
|---|---|
| The wizard's config answer, or `--config` | The current working directory |
| The wizard's target answer, or `--target` | The current working directory |
| `settings["pocket-comb"].target` | The **config file's directory** |
| The wizard's report output, or `settings.report.out` | The current working directory |
| ESLint `files` / `ignores` globs | The resolved target root |

The ESLint instance is constructed with `cwd` equal to the resolved target root, so a
config's relative globs always describe the target, never the config's own directory.

## What the wizard skips

The wizard only asks for gaps. A flag or setting can answer a prompt ahead of time:

- `settings.target` skips the target prompt.
- `settings.replace` skips the rename prompts for `replace`.
- `settings.report` skips the report prompts.
- `--config` skips the config prompt.
- `--dry-run` or `--apply` skips the apply question. `--dry-run` is terminal: no
  apply/restart/abort menu.
- An action argument, e.g. `npx pocket-comb inventory`, skips the action prompt.

Full precedence is **flag > setting > wizard answer > default** for values a setting can
carry. The wizard only prompts for gaps, so it never overrides a setting. The
[reference](reference.md#precedence) has the per-value table.

## Recipes

### JavaScript project, target is the repo root

```js
export default [
  {
    rules: {
      "no-console": "warn",
      "no-debugger": "error",
    },
  },
];
```

Run `npx pocket-comb` from the repo root, accept the config and target, and choose an
action.

### TypeScript project

```js
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["**/*.ts", "**/*.tsx"],
  languageOptions: { parser: tseslint.parser },
  rules: {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": "warn",
  },
});
```

### Monorepo: config in `tools/`, target in `apps/web`

```js
// tools/pocket-comb.config.js
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["**/*.ts", "**/*.tsx"],
  languageOptions: { parser: tseslint.parser },
  rules: { "no-console": "warn" },
  settings: {
    "pocket-comb": {
      target: "../apps/web", // relative to tools/, not to the shell's cwd
    },
  },
});
```

Run `npx pocket-comb` from the repo root, then type `tools/pocket-comb.config.js` at the
config prompt. The target prompt is skipped because the config answers it.

### Act on a subset of a repository

Set `settings.target` in the config, or type the subdirectory at the wizard's target
prompt. `files` / `ignores` can narrow the scope further:

```js
files: ["src/**/*.js"],
```

### Stable report without the report prompt

```js
settings: {
  "pocket-comb": {
    report: { format: "json", out: "reports/suppressions.json" },
  },
}
```

The wizard skips the format and output prompts when this setting is present. For CI, use
the flags in the [reference](reference.md#flags) instead.

### One config, any action

Run `npx pocket-comb` and choose a different action from the menu. The config, target, and
report settings stay the same.

## Hand-testing the config

Because the action config is a real flat config, ESLint can load it directly:

```sh
npx eslint -c ./pocket-comb.config.js src/
```

This is the fastest way to check that the parser wiring, `files` coverage, and rule
severities say what you think they say. It does not run Pocket Comb; it only proves the
config itself is valid for ESLint.

## Config errors

All config failures are operational errors: exit `2`, with a message naming the file or
key. The wizard validates the config path before running, so a bad file is caught at the
prompt.

| Message | Cause |
|---|---|
| `no action config found` | No config path and no convention file in the cwd. |
| `could not read action config` | The path does not exist or is unreadable. |
| `could not load action config` | The module threw or could not be imported. |
| `must export an array of flat config objects` | The default export is not an array. |
| `has a non-object entry` | An array entry is `null` or not an object. |
| `settings["pocket-comb"].target must be a non-empty string` | Bad `target`. |
| `settings["pocket-comb"].replace needs non-empty string 'from' and 'to'` | Bad pair. |
| `settings["pocket-comb"].report.format must be one of csv \| json \| html` | Bad format. |
| `settings["pocket-comb"].report.out must be a non-empty string` | Bad destination. |

A config that loads but names no actionable rules is not an error. Mutating actions then
find nothing to do, and `inventory` still counts directives.

## Next

- [Actions](actions.md) for what each verb does with this config.
- [Examples](examples.md) for wizard sessions and before/after deltas.
- [Reference](reference.md) for the full flag, report, and API surfaces.
