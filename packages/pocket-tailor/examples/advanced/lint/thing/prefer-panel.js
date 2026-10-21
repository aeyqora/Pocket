import { defineTailoredRule } from "pocket-tailor";

// Advanced: tailor a rule that reports by message id.
export default defineTailoredRule({
  tailors: "prefer-panel",
  meta: {
    docs: {
      description: "Prefer the shared Panel component.",
      url: "https://example.dev/components/panel",
    },
    messages: {
      usePanel:
        "Use <Panel> instead of <{{name}}>. "
        + "Guide: https://example.dev/components/panel",
    },
  },
});
