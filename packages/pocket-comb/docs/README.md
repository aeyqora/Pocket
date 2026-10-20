# Pocket Comb documentation

Pocket Comb is a CLI for mass operations on ESLint suppression directives. It can add
suppressions, autofix code, strip rules from existing directives, rename rules, prune
unused directives, and census the whole repository.

The easiest way to use it is the **wizard**. Run it with no flags, answer a few questions,
review the dry run, and choose whether to apply. The guides in this directory are written
around that flow. The full flag surface lives in the [reference](reference.md) for repeat
runs, scripts, and CI.

## Install and start

```sh
# No install: always the latest release.
npx pocket-comb@latest

# Version-pinned teams.
npm install --save-dev pocket-comb
npx pocket-comb
```

On a terminal this starts an interactive session. It asks only for what it still needs,
pre-fills the answers it can infer, and runs a **dry run** unless you say otherwise.

You can preselect the action and skip the first question:

```sh
npx pocket-comb suppress
npx pocket-comb inventory
```

Everything else still works the same way: config, target, mode, report, and the final
apply/restart/abort choice.

## What the wizard asks

| Prompt | When it appears | What it does |
|---|---|---|
| **Which action?** | No action argument | Pick one of the six actions. |
| **Action config** | No `--config` | Pre-filled with `pocket-comb.config.{js,mjs,cjs,json}` from the cwd. Press Enter to accept. |
| **Target directory** | No `--target` and no `settings.target` | Pre-filled with the resolved target, usually the cwd. |
| **Rule to rename / New rule name** | `replace`, and no flags or `settings.replace` | The two halves of the rename pair. |
| **Apply changes? (No = dry run)** | Every mutating action, unless `--dry-run` / `--apply` was given | Defaults to **No**: a dry run. |
| **Report format / Report output** | After the run, unless a report setting or flag already answers it | Choose `html` (default), `csv`, or `json`, then a path or `-` for stdout. |
| **Next** | After an interactive dry run | **Apply now**, **Restart**, or **Abort**. |

`inventory` skips the apply question entirely; it is read-only.

## A full session

Answers are shown after `›`. The prompt wording is what you see; the surrounding styling
depends on the terminal.

```text
$ npx pocket-comb

Which action?
  suppress   insert/prepend disable directives
  fix        autofix the config's rules
  remove     strip the config's rules from directives
  replace    rename rule tokens
  cleanup    prune unused directives
  inventory  read-only census

› suppress

Action config
› ./pocket-comb.config.js

Target directory
› .

Apply changes? (No = dry run)
› No

Impact: 12 files would change, 84 edits (76 inserted, 8 prepended)
  by type: insert 76, prepend 8
  by rule: no-console 61, no-unused-vars 23
Done: 12 files touched, 84 edits (76 inserted, 8 prepended) — 2.1s

Report format
› html

Report output
› ./pocket-comb-report.html

Next
  Apply now  re-run in apply mode
  Restart    change the answers
  Abort      leave the target untouched

› Apply now
```

`Apply now` re-runs the same action in apply mode. Every action is idempotent, so this is
safe. `Abort` leaves the target untouched. `Restart` goes back to the questions.

If you choose **No** to "Apply changes?", nothing is written. That is the normal way to
review a run.

## The dry run is the review

The impact summary tells you what would change before anything is written:

- files that would change;
- edits by type (`insert`, `prepend`, `strip`, `rename`, `prune`, `fix`);
- edits by rule.

When the run finishes interactively, the wizard offers to apply it. An explicit
`--dry-run` is different: it is terminal, prints the impact, and exits without the
apply/restart/abort menu. Use it when you want to stop after the review.

## When not to use the wizard

The wizard needs a terminal. Pipes and CI runs never prompt: they use flags, settings, and
defaults only. The reference documents every flag, exit code, report field, and
non-interactive rule:

- **[Reference: flags](reference.md#flags)**
- **[Reference: exit codes](reference.md#exit-codes)**
- **[Reference: reports](reference.md#reports)**

The most common non-interactive shape is a dry run as a probe:

```sh
npx pocket-comb suppress --config ./pocket-comb.config.js
```

It exits `1` when there is impact and `0` when there is none.

## Documentation map

| Page | Read it when you want to… |
|---|---|
| **[Configuration](configuration.md)** | Write the one action config every action shares. The wizard asks for this file. |
| **[Actions](actions.md)** | Choose an action and understand what it will change. |
| **[Examples](examples.md)** | See a wizard session and the before/after result for each action. |
| **[Reference](reference.md)** | Look up a flag, exit code, report field, wizard prompt rule, or exported function. |

## The mental model

**Action config vs repo config.** The action config is a standard ESLint flat config that
you write for Pocket Comb. It names the rules to act on and wires the parser. It is not
the target repository's ESLint config. Pocket Comb never loads the repo config.

**One config, six actions.** The action is chosen in the wizard (or by giving it as an
argument). The same config serves every action.

**Target.** The directory tree an action runs against. The wizard asks for it unless
`--target` or `settings.target` already answers it.

**Dry run first.** A mutating run reports its impact before writing. The wizard asks
before applying; non-interactive runs dry-run by default.

**The ledger.** Every mutating run produces a per-edit record: file, line, rule, edit
type, directive form, and before/after text. Reports are built from it.

**The census.** `inventory` is the read-only outlier. It counts every disable directive in
the target without linting, so successive censuses can be diffed to measure suppression
debt over time.

## Requirements

- Node.js 20.12 or newer.
- ESLint 9.34 or newer, flat config only. ESLint is a required peer dependency.
- A terminal for the wizard; flags for non-interactive runs.

## Next

- First time: write a config with [Configuration](configuration.md), then run
  `npx pocket-comb` and follow the prompts.
- Choosing an operation: [Actions](actions.md).
- Seeing the deltas: [Examples](examples.md).
- Scripting or CI: [Reference](reference.md).
