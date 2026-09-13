import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { gitError } from "./errors.js";
import type { ChangeMap } from "./types.js";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export class Git {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  static async discover(cwd: string): Promise<Git> {
    const probe = rawGit(["-C", cwd, "rev-parse", "--show-toplevel"]);
    if (probe.status === 0 && probe.stdout.trim().length > 0) {
      return new Git(probe.stdout.trim());
    }
    // Bare repositories have no work tree; object-graph forms still work, so
    // anchor on the git directory itself instead of failing.
    const bare = rawGit(["-C", cwd, "rev-parse", "--is-bare-repository"]);
    if (bare.status === 0 && bare.stdout.trim() === "true") {
      const gitDir = rawGit(["-C", cwd, "rev-parse", "--absolute-git-dir"]);
      return new Git(gitDir.status === 0 && gitDir.stdout.trim() ? gitDir.stdout.trim() : cwd);
    }
    const gitDirProbe = rawGit(["-C", cwd, "rev-parse", "--git-dir"]);
    if (gitDirProbe.status !== 0) {
      throw gitError("not a git repository", probe.stderr.trim());
    }
    throw gitError("unsupported repository format", probe.stderr.trim());
  }

  run(args: string[], opts: { allowFail?: boolean } = {}): GitResult {
    const res = rawGit(["-C", this.root, ...args]);
    if (res.status !== 0 && !opts.allowFail) {
      throw gitError(
        `git ${args[0]} failed: ${(res.stderr || res.stdout).trim()}`,
        { args },
      );
    }
    return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }

  runBuffer(args: string[], opts: { allowFail?: boolean } = {}): Buffer {
    const res = spawnSync("git", ["-C", this.root, ...args], {
      maxBuffer: 512 * 1024 * 1024,
    });
    if (res.error) throw gitError(`git ${args[0]} failed: ${res.error.message}`);
    if (res.status !== 0 && !opts.allowFail) {
      throw gitError(
        `git ${args[0]} failed: ${res.stderr.toString().trim()}`,
        { args },
      );
    }
    return res.stdout;
  }

  isBare(): boolean {
    return this.run(["rev-parse", "--is-bare-repository"]).stdout.trim() === "true";
  }

  isShallow(): boolean {
    return (
      this.run(["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true"
    );
  }

  promisorRemotes(): string[] {
    const res = this.run(["config", "--get-regexp", "^remote\\..*\\.promisor$"], {
      allowFail: true,
    });
    if (res.status !== 0) return [];
    return res.stdout
      .split("\n")
      .map((l) => l.split(/\s+/)[0] ?? "")
      .filter((l) => l.endsWith(".promisor"))
      .map((l) => l.replace(/^remote\./, "").replace(/\.promisor$/, ""));
  }

  tryUnshallow(): boolean {
    const res = this.run(["fetch", "--unshallow"], { allowFail: true });
    return res.status === 0;
  }

  revParse(ref: string, opts: { verify?: boolean } = {}): string {
    const args = ["rev-parse"];
    if (opts.verify) args.push("--verify", "--quiet");
    args.push(`${ref}^{commit}`);
    const res = this.run(args, { allowFail: true });
    if (res.status !== 0) {
      throw gitError(`cannot resolve ref '${ref}' to a commit`, {
        ref,
        stderr: res.stderr.trim(),
      });
    }
    return res.stdout.trim();
  }

  hasCommit(ref = "HEAD"): boolean {
    const res = this.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      allowFail: true,
    });
    return res.status === 0 && res.stdout.trim().length > 0;
  }

  parentCount(rev: string): number {
    const res = this.run(["rev-list", "--parents", "-n", "1", rev]);
    const parts = res.stdout.trim().split(/\s+/);
    return Math.max(0, parts.length - 1);
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    const res = this.run(["merge-base", "--is-ancestor", ancestor, descendant], {
      allowFail: true,
    });
    return res.status === 0;
  }

  mergeBase(a: string, b: string): string | null {
    const res = this.run(["merge-base", a, b], { allowFail: true });
    if (res.status !== 0) return null;
    const out = res.stdout.trim();
    return out.length > 0 ? out : null;
  }

  treeOf(commit: string): string {
    return this.run(["rev-parse", `${commit}^{tree}`]).stdout.trim();
  }

  emptyTree(): string {
    return this.run(["hash-object", "-t", "tree", "/dev/null"]).stdout.trim();
  }

  /** changed files + rename map + binary set between two tree-ish endpoints. */
  changeMap(baseCommit: string, headCommit: string): ChangeMap {
    return this.buildChangeMap([
      "diff",
      "--name-status",
      "-z",
      "-M",
      baseCommit,
      headCommit,
      "--",
    ], [
      "diff",
      "--numstat",
      "-z",
      "-M",
      baseCommit,
      headCommit,
      "--",
    ]);
  }

  stagedChangeMap(): ChangeMap {
    const base = this.hasCommit("HEAD") ? "HEAD" : this.emptyTree();
    return this.buildChangeMap(
      ["diff", "--cached", "--name-status", "-z", "-M", base, "--"],
      ["diff", "--cached", "--numstat", "-z", "-M", base, "--"],
    );
  }

  private buildChangeMap(nameStatusArgs: string[], numstatArgs: string[]): ChangeMap {
    return parseChangeMap(
      this.run(nameStatusArgs).stdout,
      this.run(numstatArgs).stdout,
    );
  }

  unifiedChangeHunks(
    baseCommit: string,
    headCommit: string,
  ): Map<string, { addedHead: Set<number>; removedBase: Set<number> }> {
    const out = this.run([
      "diff",
      "--unified=0",
      "-M",
      baseCommit,
      headCommit,
      "--",
    ]);
    return parseUnifiedDiff(out.stdout);
  }

  stagedUnifiedHunks(): Map<string, { addedHead: Set<number>; removedBase: Set<number> }> {
    const base = this.hasCommit("HEAD") ? "HEAD" : this.emptyTree();
    const out = this.run([
      "diff",
      "--cached",
      "--unified=0",
      "-M",
      base,
      "--",
    ]);
    return parseUnifiedDiff(out.stdout);
  }

  show(revSpec: string): string | null {
    const res = spawnSync("git", ["-C", this.root, "show", revSpec], {
      maxBuffer: 512 * 1024 * 1024,
    });
    if (res.status !== 0) return null;
    return res.stdout.toString("utf8");
  }

  showBuffer(revSpec: string): Buffer | null {
    const res = spawnSync("git", ["-C", this.root, "show", revSpec], {
      maxBuffer: 512 * 1024 * 1024,
    });
    if (res.status !== 0) return null;
    return res.stdout;
  }

  fileAt(commit: string, path: string): string | null {
    return this.show(`${commit}:${normalizePath(path)}`);
  }

  stagedFile(path: string): string | null {
    return this.show(`:${normalizePath(path)}`);
  }

  /** Extract a tree to a fresh temp dir. Returns the dir path. */
  materialize(commit: string): string {
    const dir = join(
      tmpdir(),
      `pocket-lock-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    const tar = this.runBuffer(["archive", "--format=tar", commit]);
    const res = spawnSync("tar", ["-x", "-C", dir], { input: tar });
    if (res.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      throw gitError("failed to materialize baseline tree", res.stderr.toString());
    }
    linkNodeModules(this.root, dir);
    return dir;
  }

  cleanup(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rawGit(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
}

function normalizePath(p: string): string {
  return p.split("\\").join("/");
}

function linkNodeModules(repoRoot: string, dir: string): void {
  const src = join(repoRoot, "node_modules");
  const dest = join(dir, "node_modules");
  if (existsSync(src) && !existsSync(dest)) {
    try {
      symlinkSync(src, dest, "junction");
    } catch {
      /* best effort */
    }
  }
}

export function parseUnifiedDiff(
  diff: string,
): Map<string, { addedHead: Set<number>; removedBase: Set<number> }> {
  const result = new Map<string, { addedHead: Set<number>; removedBase: Set<number> }>();
  let current: { addedHead: Set<number>; removedBase: Set<number> } | null = null;
  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") {
        const path = stripPrefix(p);
        current = { addedHead: new Set(), removedBase: new Set() };
        result.set(path, current);
      } else {
        current = null;
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m || !current) continue;
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      const newStart = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      for (let i = 0; i < oldCount; i++) current.removedBase.add(oldStart + i);
      for (let i = 0; i < newCount; i++) current.addedHead.add(newStart + i);
    }
  }
  return result;
}

function stripPrefix(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1);
  }
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

export function parseChangeMap(nameStatusOut: string, numstatOut: string): ChangeMap {
  const files = new Map<string, string>();
  const renames = new Map<string, string>();
  const binary = new Set<string>();
  const tokens = nameStatusOut.split("\0").filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++] ?? "";
    const code = status[0] ?? "M";
    if (code === "R" || code === "C") {
      const oldPath = tokens[i++] ?? "";
      const newPath = tokens[i++] ?? "";
      files.set(newPath, code);
      renames.set(newPath, oldPath);
    } else {
      const p = tokens[i++] ?? "";
      files.set(p, code);
    }
  }
  parseNumstat(numstatOut, binary);
  return { files, renames, binary };
}

export function parseNumstat(out: string, binary: Set<string>): void {
  const tokens = out.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) {
      i++;
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(t);
    if (!m) {
      i++;
      continue;
    }
    const add = m[1];
    const del = m[2];
    const path = m[3] ?? "";
    const isBinary = add === "-" || del === "-";
    if (path === "") {
      // rename/copy: old path follows, then new path
      const newPath = tokens[i + 2] ?? "";
      if (isBinary && newPath) binary.add(newPath);
      i += 3;
      continue;
    }
    if (isBinary) binary.add(path);
    i += 1;
  }
}
