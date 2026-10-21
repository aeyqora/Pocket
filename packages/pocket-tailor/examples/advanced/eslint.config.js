import { defineConfig } from "eslint/config";
import { thingStrict } from "./lint/thing/config.js";

export default defineConfig([
  thingStrict,
  {
    files: ["**/*.js"],
    rules: {
      // Strict already enables the rules; add overrides here.
    },
  },
]);
