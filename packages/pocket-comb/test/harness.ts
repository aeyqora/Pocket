import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Writable, Readable } from "node:stream";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { CommandIo } from "../src/cli.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The built bin entry the package's `bin` field points at. */
export const CLI = join(ROOT, "dist", "cli.js");

const temps: string[] = [];

/** A fresh temp directory, cleaned up when the test file's `after` runs. */
export function tempDir(prefix = "pocket-comb-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Write a file into a temp dir, creating parent directories as needed. */
export function write(dir: string, relative: string, content: string): string {
  const full = join(dir, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return full;
}

/** Clean up every temp dir this file made. Safe to call more than once. */
export function cleanupTemps(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A writable that keeps everything written to it. */
class Capture extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export interface FakeIo {
  io: CommandIo;
  stdout(): string;
  stderr(): string;
}

/** An injectable `CommandIo` whose streams and TTY-ness a test controls. */
export function fakeIo(opts: { cwd: string; tty?: boolean }): FakeIo {
  const out = new Capture();
  const err = new Capture();
  return {
    io: {
      cwd: opts.cwd,
      input: Readable.from([]),
      output: out,
      stderr: err,
      tty: opts.tty ?? false,
    },
    stdout: () => out.text(),
    stderr: () => err.text(),
  };
}

export interface BinResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the built bin in a subprocess, for the checks a test cannot fake in-process. */
export function runBin(args: string[], opts: { cwd?: string; input?: string } = {}): BinResult {
  const res: SpawnSyncReturns<string> = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    ...(opts.input === undefined ? {} : { input: opts.input }),
  });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
