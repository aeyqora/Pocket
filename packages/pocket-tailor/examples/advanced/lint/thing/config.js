import thing from "../../eslint-plugin-thing.js";
import { tailor } from "pocket-tailor";
import noWidget from "./no-widget.js";
import preferPanel from "./prefer-panel.js";

export const tailoredThing = tailor(thing, [noWidget, preferPanel]);

// Start from the upstream strict preset, then swap in the wrapped plugin.
// `tailoredThing.flatConfigs` would still point at the original plugin.
export const thingStrict = {
  ...thing.flatConfigs.strict,
  name: "app/thing-strict-tailored",
  files: ["**/*.js"],
  plugins: { thing: tailoredThing },
};
