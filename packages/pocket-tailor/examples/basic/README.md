# Basic example

One synthetic upstream plugin, one tailored rule, and a config that wraps the
plugin in place. No external plugin is installed.

The example imports `pocket-tailor` by package name, so build the package first.

```sh
cd packages/pocket-tailor
npm install
npm run build

npx eslint --config examples/basic/eslint.config.js examples/basic/src/example.js
```

Expected: one error for `widget`, with the tailored message.

```
examples/basic/src/example.js
  2:7  error  Use <WidgetPanel> instead of <widget>. Guide: https://example.dev/components/widget-panel  thing/no-widget
```

The rule id is still `thing/no-widget`. The fix is an editor suggestion:
`npx eslint --fix` changes nothing here. Add `autofix: true` to
`lint/thing/no-widget.js` to make it a real autofix.

Files:

| Path | Purpose |
|---|---|
| `eslint-plugin-thing.js` | Stand-in upstream plugin; swap for the real one. |
| `lint/thing/no-widget.js` | The tailored rule. |
| `eslint.config.js` | Wraps the plugin with `tailor()` and registers it. |
| `src/example.js` | Code to lint. |

See [authoring a tailored rule](../../docs/guides/authoring-a-tailored-rule.md)
for the hook contract and the fix/suggestion choices.
