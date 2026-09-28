import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Git } from "./git.js";
import type { Host, Policy } from "./types.js";

/**
 * What a combined-landing repository can be observed to be, gathered from the
 * working tree. The declared half comes from the policy the caller already
 * parsed, so this is the observed half plus the two declared values the findings
 * compare them against.
 */
export interface CombinedLandingFacts {
  /** The working tree's declared `host`; null when the config declares none. */
  readonly host: Host | null;
  /** Whether the working tree's policy declares the combined-landing opt-in. */
  readonly combined: boolean;
  /** The checkout's remote, classified; null when there is none or it is unknown. */
  readonly remote: HostFamily | null;
  /** The owners file and where it was found; null when there is none. */
  readonly owners: OwnersFile | null;
}

/**
 * What the checkout says about itself, gathered best-effort. Every read here is
 * allowed to come back empty — a directory that is not a repository, a git that
 * declines, an owners file that is not there — because `validate` is a
 * working-tree lint that must keep working outside a repository, and a fact it
 * could not observe is not a defect about a protected file.
 */
export async function combinedLandingFacts(
  cwd: string,
  policy: Policy,
): Promise<CombinedLandingFacts> {
  return {
    host: policy.host,
    combined: policy.allowSameChangeExceptions,
    remote: remoteFamily(await originUrl(cwd)),
    owners: ownersFileFor(cwd),
  };
}

async function originUrl(cwd: string): Promise<string | null> {
  try {
    const git = await Git.discover(cwd);
    return git.remoteUrl();
  } catch {
    return null;
  }
}

/**
 * What a checkout can be *observed* to be about the two things a combined-landing
 * repository's opt-in depends on: whether it is really on the host it declares,
 * and whether anyone is named to own the protected paths. The families are this
 * module's reason to exist, and the tier is forced to fold — a plan is not in a
 * remote URL, so an implementation that compared tiers would flag every premium
 * repository on `gitlab.com` as disagreeing with itself, and would flag the free
 * tier as agreeing for the wrong reason.
 *
 * Four read-only facts, no verdict and no failure. The core never reads host
 * *capability* or approval state, because a declared `host` is a string and a
 * remote URL is a string, and neither is a capability. `validate` turns these
 * into findings; nothing else reads them.
 *
 * The declared side is a claim under test and the observed side is the evidence,
 * and the two are only ever compared, never merged.
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

/** An owners file, with the path it was found at. */
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
 * The first owners file in a documented location, read from the working tree, or
 * null when the repository carries none.
 *
 * The working tree rather than the commit, because the caller is a pre-push lint
 * and the approval being asked about is the one that will exist once the change
 * lands: an author adding a protected path to an existing owners file in the same
 * change has made the claim, and the lint is there to notice a gap they left, not
 * to fail them for closing one in the same breath. The trade is deliberate and
 * worth stating: a staged-but-uncommitted owners file counts as coverage, so a
 * repository that never commits it loses the finding it was warned about. That
 * is a real hole, and it is the price of a lint that reads what is in front of it
 * rather than what CI would see.
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
