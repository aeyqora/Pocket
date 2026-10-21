// A stand-in for a real plugin. It exposes a `flatConfigs.strict` preset that
// embeds the plugin object, the shape several real plugins use.
const noWidget = {
  meta: {
    type: "problem",
    docs: { description: "Disallow identifiers named widget." },
    schema: [],
    messages: { noWidget: "Do not use <{{name}}>." },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === "widget") {
          context.report({ node, messageId: "noWidget", data: { name: node.name } });
        }
      },
    };
  },
};

const preferPanel = {
  meta: {
    type: "suggestion",
    docs: { description: "Prefer the Panel component." },
    schema: [],
    messages: { usePanel: "Prefer <Panel> over <{{name}}>." },
  },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === "card") {
          context.report({ node, messageId: "usePanel", data: { name: node.name } });
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "eslint-plugin-thing", version: "1.0.0", namespace: "thing" },
  rules: { "no-widget": noWidget, "prefer-panel": preferPanel },
};

plugin.flatConfigs = {
  strict: {
    name: "thing/strict",
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    plugins: { thing: plugin },
    rules: { "thing/no-widget": "error", "thing/prefer-panel": "error" },
  },
};

export default plugin;
