/**
 * The governed-path pattern dialect: the CODEOWNERS subset the policy's path
 * keys speak, hoisted out of `combined-landing.ts` so the policy parser, the
 * pipeline, and the combined-landing corroboration all consume one matcher.
 *
 * The subset is deliberate and closed: `*` stays within a path segment, `**`
 * crosses it, any `/` anchors the pattern to the repository root, a slashless
 * pattern matches that basename at any depth, a trailing `/` claims a directory
 * and everything under it, and matching is case-sensitive. There is no `!`
 * negation, no brace alternation, and no character classes — out-of-dialect
 * syntax is a config error in the policy parser, never a silent literal match.
 */

/**
 * Whether a pattern claims a repository-relative path. The dialect is the
 * documented CODEOWNERS subset, no further:
 *
 * - a trailing `/` claims the directory and everything under it;
 * - a slashless pattern matches that basename at any depth;
 * - any slash anchors the pattern to the repository root (a leading `/` is
 *   optional and changes nothing);
 * - `*` stays within a segment, `**` crosses it;
 * - `**` alone matches everything;
 * - matching is case-sensitive.
 *
 * The pattern is pure: no filesystem, no policy, just a pattern and a path.
 */
export function patternMatches(pattern: string, path: string): boolean {
  const directoryOnly = pattern.endsWith("/");
  const body = directoryOnly ? pattern.slice(0, -1) : pattern;
  // A pattern with no slash anywhere matches at any level, as in gitignore; a
  // pattern that does is relative to the repository root, whether or not that
  // root is spelled with a leading `/`.
  const anyLevel = !body.includes("/") ? "(?:.*/)?" : "";
  const glob = globToRegExp(body.startsWith("/") ? body.slice(1) : body);
  const tail = directoryOnly ? "(?:/.*)?" : "";
  return new RegExp(`^${anyLevel}${glob}${tail}$`).test(path);
}

/**
 * A pattern as a regular expression: a single `*` stops at a `/`, a double `*`
 * does not, and a double `*` between two slashes spans any number of directory
 * levels, including none.
 */
export function globToRegExp(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}

/**
 * The out-of-dialect construct a pattern carries, described for a config
 * diagnostic, or null when the pattern is inside the subset. The policy parser
 * fails closed on any of these rather than letting `globToRegExp` escape the
 * syntax into a literal: a matcher that guesses wrong about a brace is worse
 * than one that admits the pattern is outside its vocabulary.
 */
export function foreignSyntax(pattern: string): string | null {
  if (pattern.startsWith("!")) return "negation ('!')";
  if (pattern.includes("{") || pattern.includes("}")) {
    return "brace alternation ('{a,b}')";
  }
  if (pattern.includes("[") || pattern.includes("]")) {
    return "character class ('[abc]')";
  }
  return null;
}
