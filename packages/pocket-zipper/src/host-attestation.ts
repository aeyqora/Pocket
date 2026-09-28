import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "./types.js";

/**
 * The three host families, with both GitLab tiers and both Bitbucket flavors
 * folded together. The tier is forced to fold: a plan is not in a remote URL, so
 * an implementation that compared plans would flag every premium repository on
 * `gitlab.com` as disagreeing with itself, and would flag the free tier as
 * agreeing for the wrong reason.
 *
 * The families are this module's reason to exist. It holds what a tool can
 * observe about whether a repository's declared host really is the host it
 * claims to be, and about whether anyone is named to own the policy path — four
 * read-only facts, no verdict and no failure. The core never reads host
 * *capability* or approval state, because a declared `host` is a string and a
 * remote URL is a string, and neither is a capability. `validate` turns these
 * into findings; nothing else reads them.
 *
 * "Attestation" is the config reference's word for what the repository
 * *declares* about its own host, and this module is not that. It is the
 * observed counterpart: the declared `host` is the claim under test, the
 * remote URL and the owners file are what a checkout can be seen to be, and
 * the two are only ever compared, never merged.
 */
export type HostFamily = "github" | "gitlab" | "bitbucket";

const HOST_FAMILIES: Record<Host, HostFamily> = {
  github: "github",
  "gitlab-premium": "gitlab",
  "gitlab-free": "gitlab",
  "bitbucket-cloud": "bitbucket",
  "bitbucket-server": "bitbucket",
};

/** The family a declared `host` belongs to, or null when nothing is declared. */
export function hostFamily(host: Host | null): HostFamily | null {
  return host === null ? null : HOST_FAMILIES[host];
}

/**
 * The domains a checkout can be classified from, and the family each one means.
 * Only these three: a custom domain, a self-hosted GitLab, an internal mirror,
 * and a checkout with no remote are all unclassifiable, and calling one of them
 * a mismatch would cry wolf at a repository doing exactly the right thing.
 */
const REMOTE_DOMAINS = new Map<string, HostFamily>([
  ["github.com", "github"],
  ["gitlab.com", "gitlab"],
  ["bitbucket.org", "bitbucket"],
]);

/** The family a checkout's remote is on, or null when it cannot be classified. */
export function remoteFamily(url: string | null): HostFamily | null {
  if (url === null) return null;
  return REMOTE_DOMAINS.get(remoteHost(url)) ?? null;
}

/**
 * The host half of a remote URL, across the spellings git accepts: scp-like
 * (`git@host:path`), scheme (`https://host/path`), and bare (`host:path`). The
 * userinfo is stripped and the path — or the scp separator — ends the host, so
 * a path segment is never mistaken for a domain.
 */
function remoteHost(url: string): string {
  let rest = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (scheme) rest = rest.slice(scheme[0].length);
  const userinfo = rest.lastIndexOf("@");
  if (userinfo !== -1) rest = rest.slice(userinfo + 1);
  const path = rest.search(/[/:]/);
  return (path === -1 ? rest : rest.slice(0, path)).toLowerCase();
}

/** A committed owners file, with the path it was found at. */
export interface OwnersFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Where the hosts read a CODEOWNERS file from, in probe order. The three host
 * directories come first because a repository on GitHub has no reason to carry
 * the other two, and a root or `docs/` fallback would otherwise shadow a real
 * `.github/CODEOWNERS`.
 */
const OWNERS_FILE_LOCATIONS: readonly string[] = [
  ".github/CODEOWNERS",
  ".gitlab/CODEOWNERS",
  ".bitbucket/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];

/**
 * The first owners file in a documented location, read from the working tree,
 * or null when the repository carries none. The working tree rather than the
 * index because the caller is a pre-push lint: a file an author has staged but
 * not yet committed is a file they are about to rely on.
 */
export function ownersFileFor(cwd: string): OwnersFile | null {
  for (const path of OWNERS_FILE_LOCATIONS) {
    try {
      return { path, text: readFileSync(join(cwd, path), "utf8") };
    } catch {
      // Not there, or not readable: either way this location has no owners file,
      // and the next documented location is the next place a host looks.
    }
  }
  return null;
}

/**
 * Whether any rule in an owners file claims a repository-relative path. The
 * documented CODEOWNERS subset, no further: `#` comments, `[Section]` headers,
 * last match wins, `*` not crossing `/`, `**` crossing it, a leading `/`
 * anchoring to the root, and a trailing `/` claiming the directory and
 * everything under it.
 *
 * There is deliberately no `!` negation — CODEOWNERS has none, and a `!` line
 * means the file is a gitignore, so those lines are skipped rather than read as
 * patterns. Anything beyond this subset would be a gitignore engine this tool
 * has no business implementing, and a matcher that guesses wrong about a real
 * rule is worse than one that admits the rule is outside its vocabulary.
 */
export function ownersCover(text: string, path: string): boolean {
  let covered = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!") || line.startsWith("[")) {
      continue;
    }
    // The owners follow the pattern; only the pattern is read, so a line is
    // never interpreted as anything but a pattern and an owner list.
    const pattern = line.split(/\s+/)[0];
    if (pattern === undefined) continue;
    if (ownersPatternMatches(pattern, path)) covered = true;
  }
  return covered;
}

function ownersPatternMatches(pattern: string, path: string): boolean {
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
 * A CODEOWNERS pattern as a regular expression: a single `*` stops at a `/`, a
 * double `*` does not, and a double `*` between two slashes spans any number of
 * directory levels, including none.
 */
function globToRegExp(pattern: string): string {
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
