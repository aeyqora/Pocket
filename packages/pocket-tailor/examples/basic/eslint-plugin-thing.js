// A stand-in for a real plugin. Swap this for `eslint-plugin-thing` in your
// own repo; the tailored rule does not change.
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

export default {
  meta: { name: "eslint-plugin-thing", version: "1.0.0", namespace: "thing" },
  rules: { "no-widget": noWidget },
};
