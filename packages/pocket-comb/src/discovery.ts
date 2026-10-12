import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { glob } from "tinyglobby";

/**
 * The JS/TS-family default from spec §4: every extension a TypeScript/JSX repo is
 * likely to carry. The `--extensions` flag replaces it wholesale.
 */
export const DEFAULT_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
] as const;

export interface DiscoverOptions {
  /** Directory or glob; relative paths are resolved against `process.cwd()`. */
  target: string;
  extensions: string[];
}

export interface DiscoverResult {
  /** Absolute paths, sorted ascending. */
  files: string[];
  count: number;
}

/** Directories the tool never walks, regardless of `.gitignore`. */
const HARDCODED_SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

/** Glob patterns that keep tinyglobby from even descending into skipped trees. */
const SKIP_GLOBS = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.*/**"];

/** Characters that make a glob pattern dynamic (a static prefix ends here). */
const MAGIC = /[*?[\]{}()!]/;

interface TargetPlan {
  /** The directory globs and `.gitignore` patterns are anchored to. */
  root: string;
  /** The newline-joined patterns handed to tinyglobby, relative to `root`. */
  patterns: string[];
}

interface IgnoreRule {
  /** Absolute directory the pattern's `.gitignore` lived in. */
  baseDir: string;
  /** Separator count in `baseDir`; deeper rules are applied later and win. */
  depth: number;
  regex: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

/**
 * Tool-owned enumeration (spec §9): walk the target itself, never ESLint's own
 * globbing. Honors `.gitignore`, hardcoded skips (`node_modules`, `.git`, `dist`,
 * dot-directories), and the extension filter; returns absolute, sorted paths.
 */
export async function discover(options: DiscoverOptions): Promise<DiscoverResult> {
  const extensions = new Set(options.extensions.map(normalizeExtension));
  const plan = planTarget(options.target);

  const candidates = await glob(plan.patterns, {
    cwd: plan.root,
    absolute: true,
    dot: true,
    onlyFiles: true,
    ignore: SKIP_GLOBS,
  });

  const rules = await loadIgnoreRules(plan.root);

  const files = candidates
    .filter((file) => !hasSkippedSegment(plan.root, file))
    .filter((file) => extensions.has(extname(file).toLowerCase()))
    .filter((file) => !isIgnored(file, rules))
    .sort();

  return { files, count: files.length };
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/**
 * Resolve a target that may be a directory or a glob into a root directory plus
 * patterns relative to it. The root anchors `.gitignore` semantics and skip
 * checks, so it is the target itself for a directory and the longest literal
 * prefix for a glob.
 */
function planTarget(target: string): TargetPlan {
  const absolute = resolve(target);
  if (isDirectory(absolute)) {
    return { root: absolute, patterns: ["**/*"] };
  }
  const root = staticPrefix(absolute);
  const narrowed = staticRelative(root, absolute);
  return { root, patterns: [narrowed === "" ? "**/*" : narrowed] };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function staticPrefix(absolutePattern: string): string {
  const root = parse(absolutePattern).root;
  const rest = absolutePattern.slice(root.length).split(sep);
  const kept: string[] = [];
  for (const segment of rest) {
    if (segment === "" || MAGIC.test(segment)) break;
    kept.push(segment);
  }
  return kept.length === 0 ? root : root + kept.join(sep);
}

function staticRelative(root: string, absolutePattern: string): string {
  const rel = relative(root, absolutePattern);
  return rel === "" ? "**/*" : rel.split(sep).join("/");
}

/** True when a non-final path segment is a hardcoded skip or a dot-directory. */
function hasSkippedSegment(root: string, file: string): boolean {
  const segments = relative(root, file).split(sep);
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    if (HARDCODED_SKIP_DIRS.has(segment) || segment.startsWith(".")) return true;
  }
  return false;
}

/**
 * `.gitignore` sources: every ancestor up to the repository root (the nearest
 * directory containing `.git`, or the filesystem root), plus every nested
 * `.gitignore` inside the target. Deeper files are applied later, so they win.
 */
async function loadIgnoreRules(root: string): Promise<IgnoreRule[]> {
  const gitignoreFiles = new Set<string>(ancestorGitignores(root));
  const nested = await glob("**/.gitignore", {
    cwd: root,
    absolute: true,
    dot: true,
    onlyFiles: true,
    ignore: SKIP_GLOBS,
  });
  for (const file of nested) gitignoreFiles.add(file);

  const rules: IgnoreRule[] = [];
  for (const file of [...gitignoreFiles].sort()) {
    rules.push(...parseGitignore(file));
  }
  rules.sort((a, b) => a.depth - b.depth);
  return rules;
}

function ancestorGitignores(root: string): string[] {
  const found: string[] = [];
  let dir = root;
  for (;;) {
    const candidate = resolve(dir, ".gitignore");
    if (existsSync(candidate)) found.push(candidate);
    if (existsSync(resolve(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

function parseGitignore(file: string): IgnoreRule[] {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const baseDir = dirname(file);
  const depth = baseDir.split(sep).length;
  const rules: IgnoreRule[] = [];
  for (const raw of contents.split(/\r?\n/)) {
    const rule = compileRule(raw, baseDir, depth);
    if (rule !== null) rules.push(rule);
  }
  return rules;
}

function compileRule(raw: string, baseDir: string, depth: number): IgnoreRule | null {
  // Trailing whitespace is insignificant unless escaped with a backslash.
  let pattern = raw.replace(/(?<!\\)[ \t]+$/, "");
  if (pattern === "" || pattern.startsWith("#")) return null;

  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\#") || pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }

  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern === "") return null;

  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  if (pattern === "") return null;

  return { baseDir, depth, regex: compileGlob(pattern, anchored), negated, dirOnly };
}

/**
 * Gitignore glob to a regular expression. A bare pattern matches at any depth
 * (an optional leading directory prefix); a pattern containing a slash is
 * anchored to its `.gitignore`'s directory. `**` spans separators, `*` and `?`
 * do not.
 */
function compileGlob(pattern: string, anchored: boolean): RegExp {
  let out = anchored ? "^" : "^(?:.*/)?";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const prevBoundary = i === 0 || pattern[i - 1] === "/";
        const nextBoundary = pattern[i + 2] === "/";
        if (prevBoundary && nextBoundary) {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
      continue;
    }
    out += char;
  }
  return new RegExp(`${out}$`);
}

function isIgnored(file: string, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const rel = relative(rule.baseDir, file);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    if (matchesRule(rule, rel.split(sep).join("/"))) ignored = !rule.negated;
  }
  return ignored;
}

/** A rule matches the path itself, or (for directories) any ancestor prefix. */
function matchesRule(rule: IgnoreRule, rel: string): boolean {
  const parts = rel.split("/");
  const last = rule.dirOnly ? parts.length - 1 : parts.length;
  for (let i = 1; i <= last; i++) {
    if (rule.regex.test(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}
