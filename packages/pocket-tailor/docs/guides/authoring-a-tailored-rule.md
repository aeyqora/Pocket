# Authoring a tailored rule

A tailored rule is a rule-shaped module built with `defineTailoredRule`. It
answers four questions:

1. **Which upstream rule?** `tailors` names the rule inside the plugin.
2. **What should it say?** A basic `message`, or advanced per-id wording.
3. **What should each detection become?** `report()` reshapes a report, or
   returns nothing to leave it alone.
4. **Where is its documentation?** `meta.docs` is required.

The upstream plugin still decides what is flagged, under which message id, and
with what data.

## Basic: one message for every detection

The shortest useful tailored rule replaces every upstream message with one
string:

```js
// lint/thing/html-has-lang.js
import { defineTailoredRule } from "pocket-tailor";

export default defineTailoredRule({
  tailors: "html-has-lang",
  message: "Every page must declare a language.",
  meta: {
    docs: {
      description: "Require a language on the root html element.",
      url: "https://example.dev/a11y/html-language",
    },
  },
});
```

`message` overrides every detection for that rule, whether upstream reports with
a `messageId` or a plain `message`. You do not need to know which one it uses.

Upstream `data` is interpolated with `{{placeholder}}`:

```js
message: "Do not use <{{name}}>. Use <Panel> instead."
```

Missing placeholders are left untouched, same as ESLint message templates.

## Required metadata

Every tailored rule must declare:

| Field | Rule |
|---|---|
| `meta.docs.description` | Non-empty, human-readable summary. |
| `meta.docs.url` | Absolute `http` or `https` URL. |
| `message`, `meta.messages`, or `report()` | At least one presentation path. |

`defineTailoredRule()` validates this at module load and throws with the rule
name. `composeRule()` and `tailor()` apply the same guard, so a hand-built
module cannot bypass it.

`meta.docs.url` is what editors use for the rule's documentation link. A URL in
the message text is plain text; it does not replace the metadata link.

## Advanced: per-message-id tailoring

Use `meta.messages` when different upstream `messageId`s need different wording.
The key must match an id the upstream rule actually emits.

```js
export default defineTailoredRule({
  tailors: "no-widget",
  meta: {
    docs: {
      description: "Block widget elements in favour of Panel.",
      url: "https://example.dev/components/panel",
    },
    messages: {
      noWidget: "Use <Panel> instead of <{{name}}>.",
      noWidgetInForm: "Forms use <Panel>, not <{{name}}>.",
    },
  },
});
```

Authored ids merge over upstream ids, and the author wins on collisions. An id
upstream never reports is a silent no-op.

### Finding upstream message ids

There is no capability flag. A rule either reports with `messageId` or a plain
`message`; the id is chosen by the rule author.

Lint output as JSON shows what was actually reported:

```sh
npx eslint --format json src/App.jsx \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const m of JSON.parse(s)[0].messages)console.log(m.ruleId, '=>', m.messageId ?? '(plain message)')})"
```

The rule's declared ids are also visible:

```sh
node --input-type=module -e "
import plugin from 'eslint-plugin-thing';
console.log(Object.keys(plugin.rules['no-widget'].meta?.messages ?? {}));
"
```

An empty list means the rule reports plain messages; use the basic `message` or
a hook returning `{ message }`.

### Per-detection control

`report(detection, helpers)` runs once per upstream detection. `detection`
carries the upstream `messageId`, `message`, `data`, location, and options.

```js
report(detection) {
  if (detection.messageId !== "noWidget") return null; // pass through unchanged
  return {
    data: { ...detection.data, name: detection.data.name.toUpperCase() },
    fix: (fixer) => fixer.replaceText(detection.node, "Panel"),
  };
}
```

A hook wins over the basic `message` when it returns `message` or `messageId`:

```js
report(detection) {
  return detection.messageId === "noWidget"
    ? { messageId: "usePanel", data: detection.data }
    : undefined; // other ids keep the basic message or pass through
}
```

Returning `{ messageId }` resolves against the composed messages (upstream plus
authored). Returning `{ message }` uses literal text. Omitted fields are
inherited, including `data`, so `{ messageId: "usePanel" }` keeps upstream's
interpolation data.

| Author writes | Result |
|---|---|
| `message` only | Every detection says that text. |
| `message` + hook returning `{ fix }` | Basic text stays; fix applies. |
| `message` + hook returning `{ message }` / `{ messageId }` | Hook wins per detection. |
| `meta.messages` only | Id-based wording; other ids pass through. |
| `report()` only | Full per-detection control. |

## Fixes: suggestion by default

An authored `fix` becomes an **editor suggestion**. `--fix` leaves the file
alone unless the rule opts in:

```js
export default defineTailoredRule({
  tailors: "no-widget",
  message: "Use <Panel> instead of <{{name}}>.",
  autofix: true, // the authored fix becomes a real --fix autofix
  meta: {
    docs: {
      description: "Block widget elements in favour of Panel.",
      url: "https://example.dev/components/panel",
    },
  },
  report(detection) {
    return { fix: (fixer) => fixer.replaceText(detection.node, "Panel") };
  },
});
```

A fix-only rule may leave the upstream message untouched: omit `message` and
return `{ fix }`. The message is inherited; the docs URL changes.

| Intent | What to write |
|---|---|
| Suggest a change in the editor | Return `fix`; leave `autofix` out. |
| Rewrite on `--fix` | Return `fix` and set `autofix: true`. |
| Custom suggestion wording | Add `suggestionDesc`, or `suggestionMessageId` + `suggestionData`. |
| Several suggestions | Return `suggest: [{ desc, fix }, …]` directly. |

## Pass-through is not suppression

Returning `null`, `undefined`, or nothing forwards the upstream report
untouched. There is no way to skip or filter a report. To stop enforcing a rule,
set its severity to `off` in ordinary ESLint config.

## Helpers

| Field | Use |
|---|---|
| `message(id, data)` | Resolve an id against upstream + authored messages, with interpolation. |
| `sourceCode` | Read text, tokens, or comments when shaping a fix. |
| `options` | The options the user configured, exactly as upstream sees them. |
| `filename` | The linted file, for conditional presentation only. |
| `settings` | ESLint shared settings. |

Conditioning on `filename` or `options` changes **presentation only**. It must
never decide whether a report exists; that would be detection.

## Changing detection? Write a custom rule

A tailored rule cannot add reports, remove reports, suppress reports, or run its
own AST listeners. Detection belongs to upstream. If the upstream rule does not
flag what you need, write a standalone custom rule instead. If it flags too
much, use ordinary ESLint severity, `files`/`ignores`, or the upstream rule's
options.

A tailored rule only changes what an existing detection says or offers.

## Where the file lives

The module is location-agnostic. Keep repo-specific wording in the repo
(`lint/thing/…`), and ship shared wording from the package that owns the
components it references. `tailor()` accepts both in one call.

Next: [Testing and upgrades](testing-and-upgrades.md).
