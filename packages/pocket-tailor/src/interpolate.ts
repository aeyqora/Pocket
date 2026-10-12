/**
 * Message interpolation, matching ESLint's own algorithm exactly
 * (`lib/linter/interpolate.js`).
 *
 * Only `{{ ... }}` markers are substituted — there is no `%`-style
 * interpolation. The captured term is trimmed, looked up on `data` through the
 * prototype chain, and left untouched when missing. Replacement values are
 * coerced by `String#replace` (so `undefined` becomes `"undefined"`, `2n`
 * becomes `"2"`).
 */
const PLACEHOLDER_MATCHER = /\{\{([^{}]+)\}\}/gu;

export function interpolate(
  text: string,
  data?: Record<string, unknown> | null,
): string {
  if (!data) return text;
  if (!text.includes("{{")) return text;
  return text.replace(PLACEHOLDER_MATCHER, (fullMatch, termWithWhitespace: string) => {
    const term = termWithWhitespace.trim();
    return term in data ? (data[term] as string) : fullMatch;
  });
}
