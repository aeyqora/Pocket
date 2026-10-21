# Advanced example

A reusable config module built from a synthetic plugin's `flatConfigs.strict`
preset. This is the pattern to use for `jsx-a11y.flatConfigs.strict` and similar
presets.

The example imports `pocket-tailor` by package name, so build the package first.

```sh
cd packages/pocket-tailor
npm install
npm run build

npx eslint --config examples/advanced/eslint.config.js examples/advanced/src/example.js
```

Expected: two errors, one for each tailored rule, under the unchanged rule IDs.

```
examples/advanced/src/example.js
  2:7  error  Use <WidgetPanel> instead of <widget>. Guide: https://example.dev/components/widget-panel  thing/no-widget
  3:7  error  Use <Panel> instead of <card>. Guide: https://example.dev/components/panel                  thing/prefer-panel
```

Files:

| Path | Purpose |
|---|---|
| `eslint-plugin-thing.js` | Stand-in upstream plugin with a `flatConfigs.strict` preset. |
| `lint/thing/no-widget.js` | Basic `message` plus a suggested fix. |
| `lint/thing/prefer-panel.js` | Advanced `meta.messages` tailoring by message id. |
| `lint/thing/config.js` | Wraps the plugin and substitutes it into the strict preset. |
| `eslint.config.js` | Consumes the named strict config. |

The key line is in `lint/thing/config.js`:

```js
plugins: { thing: tailoredThing }
```

`thing.flatConfigs.strict` embeds the original plugin object. The config module
replaces that entry with the wrapped plugin, so every strict rule serves its
tailored version.
