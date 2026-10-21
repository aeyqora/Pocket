# Actions

Every run is one action against the action config's target. The wizard shows the six
actions with a one-line hint for each:

| Action | Wizard hint | What it does | Changes |
|---|---|---|---|
| [`suppress`](#suppress) | insert/prepend disable directives | Add directives for the config's violations. | Directive comments |
| [`fix`](#fix) | autofix the config's rules | Autofix the config's rules. | Source code |
| [`remove`](#remove) | strip the config's rules from directives | Strip the config's rules from existing directives. | Directive comments |
| [`replace`](#replace) | rename rule tokens | Rename rule tokens inside existing directives. | Directive comments |
| [`cleanup`](#cleanup) | prune unused directives | Delete directives that no longer suppress anything. | Directive comments |
| [`inventory`](#inventory) | read-only census | Count every disable directive. | Nothing |

Select one in the wizard, or preselect it with `npx pocket-comb <action>`. The rest of the
wizard still prompts for config, target, mode, and report.

## The shared wizard flow

All actions use the same session:

1. **Which action?** Pick one of the six.
2. **Action config.** Accept the detected file or type a path.
3. **Target directory.** Accept the pre-filled target or type another.
4. **Apply changes?** Defaults to **No**, which is a dry run. `inventory` skips this.
5. Review the impact.
6. **Report format / output.** Accept the defaults or choose another format or path.
7. **Next.** Apply now, restart, or abort. This appears only after an interactive dry run.

The wizard asks only for gaps. If the config already answers the target, replace pair, or
report, those prompts are skipped. If an action is given as an argument, the action prompt
is skipped. Full flag behaviour is in the [reference](reference.md#flags).

Dry run is the review step. The impact summary shows files and edits by type and rule
before anything is written. Choosing **Apply now** re-runs in apply mode; every action is
idempotent, so this is safe.

## `suppress`

**In the wizard.** Choose **suppress**, accept the config and target, then answer the
apply question. The dry run shows how many directives would be inserted or widened.

**Purpose.** Mass-insert or prepend `eslint-disable` directives for every actionable
violation under the action config's rules.

**Reads.** The config's `rules` and parser; lint messages from the isolated instance; the
directive text around each violation.

**Changes.** Directive comments only, never source code. For each violation line, Pocket
Comb aggregates the rules that fired on that line into one directive.

**Expected outcome.**

- A line with no guard gets a new `// eslint-disable-next-line <rules>` directly above
  it, indented to match the code.
- A line with an existing `line`-form or `next-line`-form guard gets any missing rule
  **prepended** to the guard's list. Existing rule order and any trailing
  `-- description` are preserved.
- A violation already covered by a guard never becomes a lint message, so the action is
  naturally idempotent.
- A violation inside a `block` span or under a `file-level` directive that does not name
  the rule gets a precise **minimal-span insert** by default: one new `next-line`
  directive inside the span. It does not widen the enclosing guard.
- A bare guard at the guard position (the violation's own line or the line above) cannot
  be scoped: it is left untouched and listed as not actionable.

**Watch out.**

- The default inserts inside an existing block span rather than editing the block. That
  keeps suppression counts exact.
- A bare guard is reported, not rewritten. Rewriting bare to explicit would break the
  other suppressions it covers.

**Beyond the wizard.** The wizard does not ask about reasons or wider guards. Those are
advanced flags, documented in the [suppress flags](reference.md#suppress-flags):

- add an audit reason to new directives;
- fix first, then suppress only the remainder;
- reuse an enclosing block or file-level guard instead of inserting per line.

## `fix`

**In the wizard.** Choose **fix**, accept the config and target, then review and apply.
There is no action-specific question.

**Purpose.** Autofix the action config's rules under the isolated instance.

**Reads.** The config's `rules` and parser, with ESLint's fixer enabled.

**Changes.** Source code, not directives. Fixes come only from the config's rules; ESLint
converges internally, so Pocket Comb never loops.

**Expected outcome.**

- A dry run reports how many files would be fixed and records one `fix` edit per file,
  without writing.
- `Apply now` writes the fixes through ESLint's own `outputFixes`.
- A file with no fixable problem is unchanged.
- The CI probe is files touched, not edit count, because autofix is not anchored to a
  single rule line.

**Watch out.**

- `fix` only runs the config's rules. If a rule is in the repo config but not the action
  config, Pocket Comb will not fix it.
- Use `suppress` with its fix-first flag when you want fixes and suppression in one run;
  the reference covers it. Use `fix` alone when you want fixes without new suppression
  debt.

## `remove`

**In the wizard.** Choose **remove**, accept the config and target, then review and apply.
The dry run lists every directive that would be stripped or deleted.

**Purpose.** Strip the action config's rules out of **every** suppression directive in
the target, across all four forms.

**Reads.** The config's rule set; every directive found by the full-file scan. It does
not depend on which directives ESLint considers used.

**Changes.** Directive comments only.

**Expected outcome.**

- A directive naming only config rules is deleted entirely.
- A directive naming a mix of config and non-config rules is rewritten with only the
  config rules removed. Existing order and a trailing `-- description` survive.
- A `block` open whose list empties is deleted, and its paired `eslint-enable` is deleted
  too when every disable it closes is gone.
- A `line`-form suffix directive loses only its comment; the code stays.
- Bare directives are left untouched and listed as not actionable, because there is no
  rule list to scope.
- Orphan `eslint-enable` directives are not `remove`'s job; `cleanup` owns those.

**Watch out.**

- `remove` is config-scoped in the opposite direction from `cleanup`: it strips rules
  even when the directive is still useful for other rules, and it never consults unused
  reporting.
- Removing a rule from a directive does not make the underlying violation go away. Expect
  lint failures after `remove` unless the code was fixed too.

## `replace`

**In the wizard.** Choose **replace**. If neither the config nor a flag carries a pair,
the wizard asks for **Rule to rename (from)** and **New rule name (to)**. Then review and
apply.

**Purpose.** Rename rule tokens inside every directive - the plugin-migration and
rule-rename action.

**Reads.** The config's directive text and one rename pair. The config's `rules` do not
scope `replace`; a token match is enough.

**Changes.** Directive comments only, in all four forms. `eslint-enable` lines are
rewritten too, so a block pair keeps closing.

**Expected outcome.**

- Exact match by default: only a directive token equal to the source is rewritten.
- A source ending in `/` is a **prefix re-point**: every token starting with that prefix
  has the prefix replaced. For example, `jsx-autofocus/` to `jsx-a11y/` rewrites
  `jsx-autofocus/autofocus` to `jsx-a11y/autofocus`.
- Bare directives name no rules and are left untouched.
- One pair per run. Multi-pair maps are not part of this release.
- After a rename, the report carries the hint `run cleanup to prune now-unused
  directives`, because a renamed rule may no longer suppress anything at its location.

**Watch out.**

- A prefix rename rewrites only the prefix. Any suffix after it is preserved.
- If the config has a `settings["pocket-comb"].replace` pair, the wizard skips the two
  rename prompts. A flag can override it; see the [reference](reference.md#replace-flags).

## `cleanup`

**In the wizard.** Choose **cleanup**, accept the config and target, then review and
apply. The dry run lists every directive or rule token that would be pruned.

**Purpose.** Prune **unused** suppression directives - the directives ESLint reports as
no longer suppressing anything.

**Reads.** The config's rule set; ESLint's always-on `reportUnusedDisableDirectives`
messages. Only unused rules in the config's set are removed, so cleanup is config-scoped.

**Changes.** Directive comments only.

**Expected outcome.**

- A multi-rule directive loses only the unused rules that the config owns. Other rules
  and a trailing `-- description` stay.
- A directive whose list empties is deleted whole.
- A bare directive is deleted whole only when ESLint flags the entire comment as unused.
  A bare directive whose unused-ness cannot be scoped stays and is reported.
- An unused `eslint-enable` with no matching disable is removed whole.
- A still-paired enable loses any rule its pruned disable no longer suppresses, so one
  apply converges and a re-run is a no-op.

**Watch out.**

- `cleanup` is not `remove`. `remove` acts on the config's rules whether or not the
  directive is used; `cleanup` acts only on unused directives and only within the config's
  rules.
- A directive naming a rule outside the action config is left alone even if it is unused.
  Add the rule to the config if you want cleanup to consider it.
- A parse-failing file is skipped, so its unused directives are not pruned.

## `inventory`

**In the wizard.** Choose **inventory**. There is no apply question and no apply/restart
menu; the census runs read-only. The wizard still asks for the config, target, and report
format and destination.

**Purpose.** The read-only census: count every **disable** directive in the target.

**Reads.** File text only. No ESLint instance, no lint pass, no parser. The config is
still required for target and report settings.

**Changes.** Nothing. There is no `--apply` and no dry-run question.

**Expected outcome.**

- Totals per `(form, rule)`, plus per-file directive counts.
- A directive naming N rules contributes N rule incidences to `totals`.
- A bare directive contributes one entry with `rule: null`, counted per form.
- `eslint-enable` is a block closer, not a suppression, and is excluded from both totals
  and per-file counts.
- Ordering is stable: form in canonical order, rule alphabetical with bare last, files by
  path. Successive censuses diff cleanly.
- The action always exits `0` on a successful census, regardless of how many directives
  it finds.

**Watch out.**

- A census counts directives, not violations. It never lints, so it cannot tell you
  whether a directive is doing anything. That is `cleanup`'s question.
- `inventory` succeeds on files ESLint could not parse, because it only scans text.

## Choosing an action

| You want to… | Choose |
|---|---|
| Add suppression comments for current violations | `suppress` |
| Fix the code instead of suppressing it | `fix` |
| Fix what can be fixed, then suppress the rest | `suppress` with its fix-first flag |
| Remove a rule from suppressions after fixing the code | `remove` |
| Rename a rule or a plugin namespace everywhere | `replace` |
| Delete suppressions that no longer suppress anything | `cleanup` |
| Measure suppression debt, or diff it over time | `inventory` |
| Add fewer, wider guards instead of one per line | `suppress` with its reuse-blocks flag |

The three advanced `suppress` behaviours are flags rather than wizard questions. The
wizard still handles the config, target, dry run, report, and apply step; add the flag to
the command when you need it. The [reference](reference.md#suppress-flags) has the exact
syntax.

## Common wizard workflows

### Pay down a rule

1. Run `npx pocket-comb`, choose **inventory**, accept the config and target, and review
   the census. Save the report if you want a baseline.
2. Run it again, choose **fix**, review the impact, and apply the fixes.
3. Run it again, choose **remove**, review which directives would lose the rule, and
   apply.

Each step is a separate wizard session; the same config serves all three.

### Adopt a renamed plugin

1. Run `npx pocket-comb`, choose **replace**, and enter the two rule names (or let
   `settings.replace` answer them). Apply the rename.
2. Run it again, choose **cleanup**, review, and apply. The replace run's report also
   hints at this.

### Authorize the current debt

1. Run `npx pocket-comb`, choose **suppress**, and answer **No** to apply.
2. Review the impact summary.
3. Choose **Apply now** when it looks right.

The dry run is the review step. If you want an audit reason on the inserted directives,
use the suppress reason flag from the [reference](reference.md#suppress-flags) instead.

### Check a change in CI

CI has no terminal, so it uses flags rather than the wizard. The short version:

```sh
npx pocket-comb suppress --config ./pocket-comb.config.js
```

Exit `1` means there is impact. See the [reference](reference.md#exit-codes) for the full
contract.

## Related

- [Configuration](configuration.md) - the shared config every action reads.
- [Examples](examples.md) - wizard sessions and before/after deltas.
- [Reference](reference.md) - flags, exit codes, report schema, wizard prompt rules.
