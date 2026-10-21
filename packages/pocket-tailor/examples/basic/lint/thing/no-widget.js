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
    // Leave detections under other message ids exactly as upstream reported them.
    if (detection.messageId !== "noWidget") return null;

    // No `autofix: true`, so this is an editor suggestion, not a `--fix` rewrite.
    return { fix: (fixer) => fixer.replaceText(detection.node, "WidgetPanel") };
  },
});
