import { defineTailoredRule } from "pocket-tailor";

export default defineTailoredRule({
  tailors: "no-widget",
  message:
    "Use <WidgetPanel> instead of <{{name}}>. "
    + "Guide: https://example.dev/components/widget-panel",
  meta: {
    docs: {
      description: "Use the local WidgetPanel component instead of a bare widget.",
      url: "https://example.dev/components/widget-panel",
    },
  },
  report(detection) {
    if (detection.messageId !== "noWidget") return null;
    return { fix: (fixer) => fixer.replaceText(detection.node, "WidgetPanel") };
  },
});
