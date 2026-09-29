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
A hook manager is usually a better fit for teams.

### Husky

If your project uses [Husky](https://typicode.github.io/husky/), add the command to the
pre-commit hook file:

```sh
echo "npx pocket-zipper pre-commit" > .husky/pre-commit
```

### lint-staged

Call `pocket-zipper pre-commit` **directly**, not through lint-staged. Pocket Zipper reads
the staged index itself and needs no filename list; lint-staged stashes partially-staged
changes while it runs, which would change the index underneath the evaluation. If you
already use lint-staged, keep Pocket Zipper as a separate pre-commit step.

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