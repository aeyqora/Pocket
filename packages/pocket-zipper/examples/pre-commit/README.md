# Pre-commit integration examples

These files wire Pocket Zipper into common Git hook setups. They all run:

```sh
npx --no-install pocket-zipper pre-commit
```

Install Pocket Zipper in the target repository first:

```sh
npm install --save-dev pocket-zipper
```

Use the recipe that matches the repository's existing setup:

- [`direct-git-hook/pre-commit`](direct-git-hook/pre-commit) — local `.git/hooks` setup.
- [`core-hooks-path/pre-commit`](core-hooks-path/pre-commit) — tracked hook with Git's
  `core.hooksPath` setting.
- [`husky/pre-commit`](husky/pre-commit) — add to a Husky hook created by `husky init`.
- [`lefthook/lefthook.yml`](lefthook/lefthook.yml) — add as a separate Lefthook command.
- [`pre-commit-framework/.pre-commit-config.yaml`](pre-commit-framework/.pre-commit-config.yaml)
  — local hook for the Python `pre-commit` framework.
- [`simple-git-hooks/.simple-git-hooks.json`](simple-git-hooks/.simple-git-hooks.json) —
  standalone configuration for simple-git-hooks.

Keep existing hook commands and add Pocket Zipper as a separate step. Do not pass filenames or
wrap the command in `lint-staged`; Pocket Zipper reads the staged index itself.

## Verbose output

Recipes stay quiet when the check passes. To show the recorded dispositions and cleanup summary,
change the command in any recipe to:

```sh
npx --no-install pocket-zipper pre-commit --verbose
```

## Setup references

See the [pre-commit hook guide](../../docs/guides/pre-commit.md) for installation commands,
automatic hook installation, staged-index semantics, and the relationship to CI.
