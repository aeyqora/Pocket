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
    const stderr = [probe.stderr, bare.stderr, gitDirProbe.stderr]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
    if (gitDirProbe.status === 0 || /repo version|repository format|repository extension/i.test(stderr)) {
      throw gitError("unsupported repository format", stderr);
    }
    throw gitError("not a git repository", stderr);
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

  /**
   * The `origin` remote's URL, or null when the repository has no `origin` or
   * git declines to name one. Never throws, because its only caller is
   * `validate` — a working-tree lint that must keep working outside a
   * repository, where a read that failed would be a defect about a file nobody
   * has asked about.
   */
  remoteUrl(): string | null {
    const res = this.run(["remote", "get-url", "origin"], { allowFail: true });
    const url = res.stdout.trim();
    return res.status === 0 && url.length > 0 ? url : null;
  }

  revParse(ref: string, opts: { verify?: boolean } = {}): string {
    const args = ["rev-parse"];
    if (opts.verify) args.push("--verify", "--quiet");
    args.push(`${ref}^{commit}`);
    const res = this.run(args, { allowFail: true });
    if (res.status !== 0) {
      throw gitError(
        `cannot resolve ref '${ref}' to a commit; fetch the explicit refspec or pass the host-provided SHA`,
        { ref, stderr: res.stderr.trim() },
      );
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

  mergeBase(a: string, b: string): string | null {
    const res = this.run(["merge-base", a, b], { allowFail: true });
    if (res.status !== 0) return null;
    const out = res.stdout.trim();
    return out.length > 0 ? out : null;
  }

  treeOf(commit: string): string {
    return this.run(["rev-parse", `${commit}^{tree}`]).stdout.trim();
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
    const base = this.hasCommit("HEAD") ? "HEAD" : EMPTY_TREE;
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

  show(revSpec: string): string | null {
    const res = spawnSync("git", ["-C", this.root, "show", revSpec], {
      maxBuffer: 512 * 1024 * 1024,
    });
    if (res.status !== 0) return null;
    return res.stdout.toString("utf8");
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
      `pocket-zipper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    // Materialize with git alone (read-tree into a throwaway index, then
    // checkout-index) so the only external runtime binary is git — no tar.
    // Works for commits and raw tree hashes alike, in normal, bare, and
    // linked-worktree repositories, on every OS.
    const gitDir = this.run(["rev-parse", "--absolute-git-dir"]).stdout.trim();
    const index = `${dir}.idx`;
    const env = { ...process.env, GIT_INDEX_FILE: index, LC_ALL: "C", LANG: "C" };
    try {
      const readTree = spawnSync("git", ["-C", this.root, "read-tree", commit], {
        env,
        maxBuffer: 512 * 1024 * 1024,
      });
      if (readTree.status !== 0) {
        throw gitError(
          "failed to read baseline tree",
          (readTree.stderr || readTree.stdout).toString().trim(),
        );
      }
      const checkout = spawnSync(
        "git",
        ["--git-dir=" + gitDir, "--work-tree=" + dir, "checkout-index", "-a", "-f"],
        { env, maxBuffer: 512 * 1024 * 1024 },
      );
      if (checkout.status !== 0) {
        throw gitError(
          "failed to materialize baseline tree",
          (checkout.stderr || checkout.stdout).toString().trim(),
        );
      }
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    } finally {
      rmSync(index, { force: true });
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
    // Stable English diagnostics: the unsupported-format posture keys off git's
    // error text, so locale must not change it.
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
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
