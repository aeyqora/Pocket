# Examples

The examples use the wizard. Run `npx pocket-comb`, pick an action, accept the detected
config and target, and answer **No** to "Apply changes?" for a dry run. Choose **Apply
now** after the impact if the result looks right.

Set up the sample repository first:

```sh
mkdir -p src
cat > package.json <<'EOF'
{
  "type": "module"
}
EOF

cat > src/session.js <<'EOF'
// eslint-disable-next-line no-console, no-unused-vars -- legacy
console.log("guarded");

console.log("unguarded");

/* eslint-disable no-console */
console.log("block");

/* eslint-enable no-console */

// eslint-disable-next-line no-console
const unused = 1;

// eslint-disable-next-line no-unused-vars
const answer = 42;
EOF
```

The main config:

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

## A wizard session

A dry run, with the answers shown after `›`:

```text
$ npx pocket-comb

Which action?
› suppress

Action config
› ./pocket-comb.config.js

Target directory
› .

Apply changes? (No = dry run)
› No

Impact: 1 files would change, 2 edits (1 inserted, 1 prepended)
  by type: insert 1, prepend 1
  by rule: no-console 1, no-unused-vars 1
Done: 1 files touched, 2 edits (1 inserted, 1 prepended) — 0.2s

Report format
› html

Report output
› ./pocket-comb-report.html

Next
› Apply now
```

`Apply now` re-runs the same action in apply mode. Choose **Abort** to leave the files
untouched. The rest of the examples show the result of choosing **Apply now**.

Each action below starts the same way. Only the action choice and any action-specific
prompts differ.

## `suppress`: add directives

Choose **suppress** in the wizard.

```js
// eslint-disable-next-line no-console, no-unused-vars -- legacy
console.log("guarded");

// eslint-disable-next-line no-console
console.log("unguarded");

/* eslint-disable no-console */
console.log("block");

/* eslint-enable no-console */

// eslint-disable-next-line no-unused-vars, no-console
const unused = 1;

// eslint-disable-next-line no-unused-vars
const answer = 42;
```

**Delta.** Two changes. The unguarded `console.log` got a new `next-line` directive. The
guard above `const unused` named only `no-console`, so `no-unused-vars` was **prepended**
to it. Everything already covered was left alone: the first directive and the block span.

The new rule goes to the front of the list. The existing order and the `-- legacy`
description survive.

## `fix`: change the code

Choose **fix** in the wizard. Add `src/answer.js`:

```js
const answer = "yes"
```

Save this config as `fix.config.js`:

```js
export default [
  {
    rules: {
      quotes: ["error", "single"],
      semi: ["error", "always"],
    },
  },
];
```

At the **Action config** prompt, type `./fix.config.js`. The result:

```js
const answer = 'yes';
```

**Delta.** No directive was added. The source changed. The ledger records one `fix` per
changed file, rule `(autofix)`, not one record per changed character.

The dry run's impact line is file-based:

```text
Impact: 1 files would change, 1 edits (0 inserted, 0 prepended, 1 fixed)
  by type: fix 1
  by rule: (autofix) 1
```

## `remove`: strip rules from directives

Save this config as `no-console.config.js`:

```js
export default [{ rules: { "no-console": "warn" } }];
```

Choose **remove** in the wizard, and type `./no-console.config.js` at the config prompt.

```js
// eslint-disable-next-line no-unused-vars -- legacy
console.log("guarded");

console.log("unguarded");

console.log("block");


const unused = 1;

// eslint-disable-next-line no-unused-vars
const answer = 42;
```

**Delta.**

- The first directive lost `no-console` but kept `no-unused-vars` and `-- legacy`.
- The block open lost its only rule, so the directive was deleted.
- Its paired `eslint-enable` was deleted too.
- The `// eslint-disable-next-line no-console` guard named only `no-console`, so the
  whole directive was deleted.
- The last directive names only `no-unused-vars`, which is outside this config, so it was
  untouched.

Deleting a whole directive removes only its line; the blank lines around it remain. A
formatter will collapse them if your style requires that.

No source code changed. The violations are still there; they are simply no longer
suppressed.

If the config included both rules, `remove` would delete every directive in this file.
That is the difference from `cleanup`.

## `replace`: rename rule tokens

Choose **replace** in the wizard. With the main config, it asks:

```text
Rule to rename (from)
› no-console

New rule name (to)
› no-console-logs
```

The result:

```js
// eslint-disable-next-line no-console-logs, no-unused-vars -- legacy
console.log("guarded");

console.log("unguarded");

/* eslint-disable no-console-logs */
console.log("block");

/* eslint-enable no-console-logs */

// eslint-disable-next-line no-console-logs
const unused = 1;

// eslint-disable-next-line no-unused-vars
const answer = 42;
```

**Delta.** Every `no-console` token changed to `no-console-logs`, including the block
open and its `eslint-enable`, so the pair still closes. Nothing else changed. The report
adds the hint `run cleanup to prune now-unused directives`.

### Prefix rename

Choose **replace** and enter `jsx-autofocus/` as the source and `jsx-a11y/` as the
destination. Input in `src/component.js`:

```js
// eslint-disable-next-line jsx-autofocus/autofocus
const node = document.createElement("input");
```

Output:

```js
// eslint-disable-next-line jsx-a11y/autofocus
const node = document.createElement("input");
```

**Delta.** A source ending in `/` re-points the whole namespace. The suffix
(`autofocus`) is preserved.

Exact matching is still exact when there is no trailing slash. `no-console/extra` does
not match a pair whose source is `no-console`; use `no-console/` as the source for a
namespace rewrite.

## `cleanup`: prune unused directives

Choose **cleanup** in the wizard with the main config.

```js
// eslint-disable-next-line no-console -- legacy
console.log("guarded");

console.log("unguarded");

/* eslint-disable no-console */
console.log("block");

/* eslint-enable no-console */

const unused = 1;

// eslint-disable-next-line no-unused-vars
const answer = 42;
```

**Delta.** This is the cleanup counterpart to `remove`:

- The first directive was used for `no-console` but not for `no-unused-vars`, so only the
  unused rule was pruned. The description stayed.
- The block's `no-console` directive is still used, so the block and enable stayed.
- The `no-console` guard above `const unused` suppressed nothing, so it was deleted.
- The `no-unused-vars` guard above `const answer` is used, so it stayed.

`cleanup` only considers rules in the config. A stale directive naming a rule outside the
config is left alone.

## `inventory`: count, change nothing

Choose **inventory** in the wizard. It skips the apply question. At the report prompts,
choose **csv** and enter `-` for stdout:

```text
Report format
› csv

Report output
› -
```

```csv
form,rule,count
next-line,no-console,2
next-line,no-unused-vars,2
block,no-console,1
```

**Delta.** None. The file is unchanged. The census reports:

- 4 disable directives total (`next-line` 3, `block` 1);
- 5 rule incidences, because the first directive names two rules;
- `eslint-enable no-console` is not counted, because an enable is a block closer rather
  than a suppression.

The CSV is stable across runs, so two censuses can be diffed directly.

## Advanced flags the wizard does not ask about

The wizard covers the config, target, dry run, report, and apply step. A few `suppress`
and `replace` behaviours are only available as flags. They do not replace the wizard;
they answer part of the command before it starts.

### `suppress --reason`

Add a reason to **inserted** directives:

```sh
npx pocket-comb suppress --reason "legacy logging"
```

Accept the config and target in the wizard. A line with no guard:

```js
console.log("debug");
```

becomes:

```js
// eslint-disable-next-line no-console -- legacy logging
console.log("debug");
```

A line whose guard already has a description keeps that description. The reason is only
added to inserted directives:

```js
// eslint-disable-next-line no-unused-vars -- keep me
console.log("debug");
```

becomes:

```js
// eslint-disable-next-line no-console, no-unused-vars -- keep me
console.log("debug");
```

### `suppress --fix-first`

Fix the fixable problems first, then suppress only the remainder:

```sh
npx pocket-comb suppress --fix-first
```

Input in `src/log.js`:

```js
console.log("debug")
```

With a config that enables `no-console` and `semi`:

```js
// eslint-disable-next-line no-console
console.log("debug");
```

### `suppress` inside a block: default vs `--reuse-blocks`

Input:

```js
/* eslint-disable no-unused-vars */
const answer = 42;
console.log(answer);
```

The wizard's default (`suppress`) keeps the existing guard and inserts a precise
directive:

```js
/* eslint-disable no-unused-vars */
const answer = 42;
// eslint-disable-next-line no-console
console.log(answer);
```

With `npx pocket-comb suppress --reuse-blocks`:

```js
/* eslint-disable no-console, no-unused-vars */
const answer = 42;
console.log(answer);
```

**Delta.** The default keeps the block unchanged and inserts one precise directive, so
the suppression count is exact. Reusing blocks widens the existing file-level guard
instead and inserts nothing.

`--reuse-blocks` widens the opening directive, but does not add the rule to a named
`eslint-enable` closer. Prefer a file-level directive, or check the enable line before
applying.

## The same file, six ways

Starting from `src/session.js` above:

| Action | What happens to the directives | Source code |
|---|---|---|
| `suppress` | Adds a missing guard and widens one guard; leaves existing guards and spans alone. | Unchanged |
| `fix` | Does not read or write directives; fixes code. | Changed |
| `remove` | Strips the config's rules from every directive; deletes emptied directives and paired enables. | Unchanged |
| `replace` | Renames matching rule tokens in every directive, including block pairs. | Unchanged |
| `cleanup` | Deletes only directives or rule tokens ESLint reports as unused, within the config's rules. | Unchanged |
| `inventory` | Writes nothing; reports counts per `(form, rule)` and per file. | Unchanged |

The short version:

- `suppress` **adds**; `fix` **repairs code**.
- `remove` acts on **your rule set**; `cleanup` acts on **unused** directives.
- `replace` **renames tokens**.
- `inventory` **measures**.

## CI without the wizard

CI has no terminal, so it uses flags. A dry run exits `1` exactly when there is impact, so
these are valid gates:

```sh
# Fail if any directive would need to change to suppress current violations.
npx pocket-comb suppress --config ./pocket-comb.config.js

# Fail if any suppression is unused.
npx pocket-comb cleanup --config ./pocket-comb.config.js

# Never fails on a successful census; pipe it to your trend store.
npx pocket-comb inventory --format csv --out - >> suppressions.csv
```

`fix` is the exception: its dry-run probe is "any file would be fixed", not an edit
count. The full non-interactive surface is in the [reference](reference.md#flags).

## Related

- [Configuration](configuration.md) for the config used here.
- [Actions](actions.md) for the full behaviour of each verb.
- [Reference](reference.md) for flags, exit codes, and report fields.
