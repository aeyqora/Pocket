import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { EvaluationRecord } from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(ROOT, "dist", "cli.js");

/**
 * The two protected files, re-exported from the module that owns them so a test
 * names the same path the tool does.
 *
 * `validate.test.ts` deliberately does *not* import these: it re-spells both, so
 * that renaming a protected file in the source surfaces there as a changed
 * expectation rather than as a silently-changed constant. That is the point of
 * one file spelling them out, and it only works while the rest import.
 */
export { PROTECTED_CONFIG, PROTECTED_REGISTRY } from "../src/validate.js";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  record: EvaluationRecord | null;
}

export class FixtureRepo {
  readonly dir: string;
  private counter = 0;

  constructor(dir: string) {
    this.dir = dir;
  }

  git(args: string[], opts: { allowFail?: boolean } = {}): string {
    const res = spawnSync("git", ["-C", this.dir, ...args], { encoding: "utf8" });
    if (res.status !== 0 && !opts.allowFail) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }
    return res.stdout;
  }

  write(path: string, content: string): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  writeBytes(path: string, bytes: Buffer): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }

  read(path: string): string {
    return readFileSync(join(this.dir, path), "utf8");
  }

  remove(path: string): void {
    rmSync(join(this.dir, path), { force: true });
  }

  mkdir(path: string): void {
    mkdirSync(join(this.dir, path), { recursive: true });
  }

  stage(path?: string): void {
    this.git(["add", path ?? "-A"]);
  }

  commit(message: string): string {
    this.git(["add", "-A"]);
    this.git(["commit", "-q", "-m", message]);
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  emptyCommit(message: string): string {
    this.git(["commit", "-q", "--allow-empty", "-m", message]);
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  rev(ref: string): string {
    return this.git(["rev-parse", ref]).trim();
  }

  branch(name: string): void {
    this.git(["branch", name]);
  }

  checkout(ref: string, opts: { create?: string } = {}): void {
    if (opts.create) this.git(["checkout", "-q", "-b", opts.create, ref]);
    else this.git(["checkout", "-q", ref]);
  }

  runCli(args: string[], opts: { json?: boolean; input?: string } = {}): RunResult {
    const jsonPath = join(
      tmpdir(),
      `pocket-zipper-record-${process.pid}-${Date.now()}-${this.counter++}.json`,
    );
    return runCliIn(this.dir, args, jsonPath, opts.json !== false, opts.input);
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export function runCliIn(
  dir: string,
  args: string[],
  jsonPath?: string,
  writeJson = true,
  input?: string,
): RunResult {
  const target = jsonPath ?? join(tmpdir(), `pocket-zipper-record-${process.pid}-${Date.now()}.json`);
  const fullArgs = [...args];
  if (writeJson) fullArgs.push("--json", target);
  const res: SpawnSyncReturns<string> = spawnSync(process.execPath, [CLI, ...fullArgs], {
    cwd: dir,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
  });
  let record: EvaluationRecord | null = null;
  if (existsSync(target)) {
    record = JSON.parse(readFileSync(target, "utf8")) as EvaluationRecord;
    rmSync(target, { force: true });
  }
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    record,
  };
}

/**
 * Every fixture this file made, cleaned up when the file's tests finish.
 *
 * A test file that needs a repo calls `repo()` and nothing else. Registration
 * used to be the caller's: nineteen files carried the same six lines, and one
 * more declared the array without ever wiring up the hook, so its fixtures were
 * never cleaned up at all.
 *
 * Call it once per test file, from that file's own `after`:
 *
 * ```ts
 * import { after } from "node:test";
 * import { cleanupRepos, repo } from "./harness.js";
 *
 * after(cleanupRepos);
 * ```
 *
 * Keeping the hook in the test file rather than on a `process` exit handler is
 * deliberate: cleanup should happen when the file's tests are done, not whenever
 * the runner happens to end, and the two-line call is what buys that.
 */
const repos: FixtureRepo[] = [];

/**
 * A fresh fixture repo — an initialised git repository in a temp directory,
 * configured with an identity so commits work — registered for cleanup at this
 * file's `after`.
 */
export function repo(): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), "pocket-zipper-test-"));
  const fixture = new FixtureRepo(dir);
  fixture.git(["init", "-q", "-b", "main"]);
  fixture.git(["config", "user.email", "test@example.com"]);
  fixture.git(["config", "user.name", "Test"]);
  repos.push(fixture);
  return fixture;
}

/** Clean up every fixture this file made. Safe to call more than once. */
export function cleanupRepos(): void {
  for (const fixture of repos.splice(0)) fixture.cleanup();
}

/** A standard flat config enabling a set of core rules at error severity. */
export function eslintConfig(rules: Record<string, string>): string {
  const body = Object.entries(rules)
    .map(([rule, sev]) => `    "${rule}": ${JSON.stringify(sev)}`)
    .join(",\n");
  return `export default [\n  {\n    rules: {\n${body}\n    },\n  },\n];\n`;
}

export function configYaml(opts: {
  enabled?: boolean;
  governedRules?: string[];
  defaultExpiry?: string;
  maxExpiry?: string;
  allowSameChangeExceptions?: boolean;
  host?: string;
}): string {
  const lines: string[] = [];
  if (opts.enabled !== undefined) lines.push(`enabled: ${opts.enabled}`);
  if (opts.governedRules !== undefined) {
    lines.push("governedRules:");
    for (const r of opts.governedRules) lines.push(`  - ${r}`);
  }
  if (opts.defaultExpiry !== undefined || opts.maxExpiry !== undefined) {
    lines.push("exceptions:");
    if (opts.defaultExpiry !== undefined) lines.push(`  defaultExpiry: ${opts.defaultExpiry}`);
    if (opts.maxExpiry !== undefined) lines.push(`  maxExpiry: ${opts.maxExpiry}`);
  }
  if (opts.allowSameChangeExceptions !== undefined) {
    lines.push(`allowSameChangeExceptions: ${opts.allowSameChangeExceptions}`);
  }
  if (opts.host !== undefined) lines.push(`host: ${opts.host}`);
  return lines.join("\n") + "\n";
}

export function exceptionYaml(record: {
  rule: string;
  suppressionType: string;
  fingerprint: string;
  file: string;
  type?: "temporary" | "permanent";
  expires?: string;
  line?: number;
}): string {
  const lines = [
    `- rule: ${record.rule}`,
    `  suppression_type: ${record.suppressionType}`,
    `  fingerprint: ${record.fingerprint}`,
    `  file: ${record.file}`,
    `  type: ${record.type ?? "temporary"}`,
    `  reason: needed`,
    `  reference: "#1"`,
  ];
  if (record.expires) lines.push(`  expires: ${record.expires}`);
  if (record.line !== undefined) lines.push(`  line: ${record.line}`);
  return lines.join("\n") + "\n";
}

/**
 * Whether an evaluation record carries an error with the given code. Typed over
 * `code: string` rather than `ErrorCode` deliberately: a test that pins a new
 * code is written before the code is in the union, so a name that does not exist
 * yet should read as a failing assertion rather than a type error.
 */
export function hasErrorCode(
  record: { errors: Array<{ code: string }> } | null,
  code: string,
): boolean {
  return record?.errors.some((e) => e.code === code) ?? false;
}

export const NEXT_LINE_NO_CONSOLE_FP =
  "v1:sha256:aa3906bd4b359e41c41625a924d3d3bbe95138e721f89cd87cd38839056a0f3e";
export const NEXT_LINE_NO_DEBUGGER_FP =
  "v1:sha256:61de84d29f5ac52d69962ac28ca6fd2641c241ba465381af1992868081eae6b5";
