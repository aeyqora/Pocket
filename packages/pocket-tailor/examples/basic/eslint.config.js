import { defineConfig } from "eslint/config";
import { tailor } from "pocket-tailor";
import thing from "./eslint-plugin-thing.js";
import noWidget from "./lint/thing/no-widget.js";

// Wrap once, before any config registers the plugin under its namespace.
const tailoredThing = tailor(thing, [noWidget]);

export default defineConfig([
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    plugins: { thing: tailoredThing },
    rules: { "thing/no-widget": "error" },
  },
]);
