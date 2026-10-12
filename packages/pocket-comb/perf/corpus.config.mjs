// The isolated action config the perf harness lints the corpus with (spec §10).
//
// Core rules only: the corpus is plain JS, so no parser wiring is needed, and the
// severity mix (`warn` + `error`) exercises "severity is membership" — both are
// actionable. No `files` globs, so the config applies to every linted file.
export default [
  {
    rules: {
      "no-console": "warn",
      "no-unused-vars": "error",
    },
  },
];
