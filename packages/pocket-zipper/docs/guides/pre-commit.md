# Pre-commit hook

The pre-commit mode gives you the gate's verdict locally, before you push. It is **early
feedback only** — the authoritative check is the CI run, because a hook is local,
optional, and bypassable.

```sh
npx pocket-zipper pre-commit
```

For editing the registry itself — not a change under evaluation — use
[`pocket-zipper validate`](exceptions.md#pocket-zipper-validate) instead: it lints both
protected files in your working tree and prints every defect and hygiene finding.

## What it evaluates

- **The staged index only.** Unstaged worktree edits are ignored, so the verdict matches
  what `git commit` would actually record.
- The baseline is `HEAD`; in a repository with no commits yet, the baseline is the empty
  tree, so any governed suppression in your first commit is new debt.
- Silent on pass unless you pass `--verbose`. Loud on failure.

Add `--json <path>` if you want the evaluation record written to disk:

```sh
npx pocket-zipper pre-commit --json pocket-zipper.json
```

## Wiring it

Install Pocket Zipper as a development dependency when the hook is part of the repository:

```sh
npm install --save-dev pocket-zipper
```

The recipes below use `npx --no-install` so a commit hook never downloads a missing package.
Copyable files for each integration are available in the
[pre-commit examples directory](../../examples/pre-commit/).

### Choosing an integration

| Integration | Best fit |
| --- | --- |
| [Tracked `core.hooksPath`](#tracked-git-hook) | A repository that wants no hook manager dependency |
| [Husky](#husky) | A Node.js project already using Husky |
| [Lefthook](#lefthook) | A polyglot project or a repository with several hook commands |
| [`pre-commit` framework](#pre-commit-framework) | A Python or multi-language project already using `pre-commit` |
| [simple-git-hooks](#simple-git-hooks) | A small Node.js project wanting minimal configuration |

All integrations should invoke Pocket Zipper directly. Do not pass filenames or wrap this
command in `lint-staged`; Pocket Zipper reads the staged index itself.

### Plain git hook

Create `.git/hooks/pre-commit` (and make it executable):

```sh
#!/bin/sh
npx pocket-zipper pre-commit
```

```sh
chmod +x .git/hooks/pre-commit
```

Note that `.git/hooks/` is not committed, so each clone needs this set up separately.
Use a tracked hook directory for a team setup without a hook manager.

### Tracked Git hook

Commit a hook in a repository directory, then point Git at that directory:

```sh
mkdir -p .githooks
cp examples/pre-commit/core-hooks-path/pre-commit .githooks/pre-commit
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
```

The `core.hooksPath` setting is local Git configuration, so each clone must run the final
command. The hook file itself is committed and shared with the repository.

### Husky

If your project uses [Husky](https://typicode.github.io/husky/), add the command to the
pre-commit hook file:

```sh
npm install --save-dev husky
npx husky init
```

Then add this line to `.husky/pre-commit`:

```sh
npx --no-install pocket-zipper pre-commit
```

If the hook already runs other commands, keep them and add Pocket Zipper as a separate line.

### Lefthook

Install [Lefthook](https://lefthook.dev/) and create `lefthook.yml`:

```sh
npm install --save-dev lefthook
npx lefthook install
```

```yaml
pre-commit:
  commands:
    pocket-zipper:
      run: npx --no-install pocket-zipper pre-commit
```

Do not add a file filter or `{staged_files}` to this command. Add other checks as separate
commands. For automatic installation after cloning, add `lefthook install` to the project's
existing `prepare` script.

### Pre-commit framework

The [pre-commit framework](https://pre-commit.com/) works well when a project already uses
Python tooling or supports several languages. Install it, add the local hook configuration,
then install its Git hook:

```sh
python -m pip install pre-commit
pre-commit install
```

Add this entry to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: local
    hooks:
      - id: pocket-zipper
        name: pocket-zipper
        entry: npx --no-install pocket-zipper pre-commit
        language: system
        always_run: true
        pass_filenames: false
```

`always_run` is required because Pocket Zipper must also evaluate commits with no matching
filenames. `pass_filenames` is required because Pocket Zipper evaluates the staged index,
not a filename list supplied by the runner.

### simple-git-hooks

[simple-git-hooks](https://github.com/toplenboren/simple-git-hooks) keeps a small hook
configuration in a Node.js project:

```sh
npm install --save-dev simple-git-hooks
cp examples/pre-commit/simple-git-hooks/.simple-git-hooks.json .simple-git-hooks.json
npx simple-git-hooks
```

The copied file contains:

```json
{
  "pre-commit": "npx --no-install pocket-zipper pre-commit"
}
```

Add `simple-git-hooks` to the project's existing `prepare` script so fresh installs update
hooks automatically. This tool supports one command per hook; combine it with an existing
command using `&&`, or call a project script that runs both commands.

### lint-staged

Call `pocket-zipper pre-commit` **directly**, not through lint-staged. Pocket Zipper reads
the staged index itself and needs no filename list; lint-staged stashes partially-staged
changes while it runs, which would change the index underneath the evaluation. If you
already use lint-staged, keep Pocket Zipper as a separate pre-commit step.

### Verbose output

The command stays quiet on a successful pre-commit run by default. Keep that default for
low-noise commits. To print the recorded dispositions and cleanup summary, add `--verbose`:

```diff
- npx --no-install pocket-zipper pre-commit
+ npx --no-install pocket-zipper pre-commit --verbose
```

The same one-token change applies to every recipe in the examples directory. Failures remain
loud without `--verbose`.

## Relationship to the CI check

The pre-commit hook and the CI `check` use the same evaluation. They differ only in what
they compare against:

- `pre-commit` — baseline `HEAD`, proposed change the staged index.
- `check --base <ref>` — baseline resolved from git against the target ref, proposed
  change the tree under evaluation (the merge result in CI, or `HEAD`).

A suppression the hook lets through can still fail CI if it lands as new debt relative to
the target branch. Treat the hook as a convenience, not a substitute.

## Next steps

- [CI quick-starts](ci/github.md) — put the authoritative check in your pipeline.
- [Handling a failure](handling-a-failure.md) — what to do when the hook fails.
- [Exceptions: the registry format](exceptions.md) — `validate` and the finding vocabulary.
- [Authoring an exception](authoring-an-exception.md) — the wizard, for registry work.
- [Troubleshooting](troubleshooting.md) — when the hook runs oddly or fails to resolve git state.
