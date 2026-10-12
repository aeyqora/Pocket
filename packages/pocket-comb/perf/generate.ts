/**
 * The committed, deterministic perf-corpus generator (spec §11).
 *
 * A seeded PRNG (mulberry32) means the same seed always produces a
 * byte-identical corpus, so the harness's medians compare like for like across
 * runs and machines. Every hot-path shape the engine must survive is packed
 * deliberately — clean / sparse / dense violations, all four directive forms,
 * bare guards, multi-rule lists, `-- description` suffixes, block pairs with
 * their `eslint-enable`, CRLF line endings, a BOM, and long lines — not only the
 * line-local forms the earlier spike corpus happened to carry.
 *
 * The corpus is throwaway and machine-local, so it is generated outside the
 * repository by default. That is deliberate: discovery honours `.gitignore`, so
 * a corpus parked under a gitignored path would be discovered as zero files and
 * the discover stage would measure nothing. `out` can still point anywhere
 * (e.g. a gitignored `perf/corpus/` for a manual inspection run).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The spike's fixed seed, kept so the default corpus matches its lineage. */
export const DEFAULT_SEED = 0x50434f4d;

/** Default scale: 2,000 files (spec §11). */
export const DEFAULT_FILE_COUNT = 2000;

/** Stress scale: 20,000 files (spec §11). */
export const STRESS_FILE_COUNT = 20000;

/**
 * Every shape the corpus must pack. Assignment is `SHAPES[i % length]`, so a
 * corpus at least `SHAPES.length` files long is guaranteed to cover them all.
 */
export const SHAPES = [
  "clean",
  "sparse-insert",
  "dense-insert",
  "next-line-guarded",
  "next-line-bare",
  "line-suffix",
  "line-bare",
  "multi-rule",
  "block-pair",
  "file-level",
  "description-suffix",
  "crlf",
  "bom",
  "long-line",
] as const;

export type CorpusShape = (typeof SHAPES)[number];

export interface CorpusEntry {
  /** Base name within the corpus directory, e.g. `f00042.js`. */
  name: string;
  shape: CorpusShape;
}

export interface CorpusManifest {
  schema: 1;
  seed: number;
  files: number;
  /** How many files carry each shape (SHAPES order). */
  shapes: Record<string, number>;
  /** One entry per file, in generation order. */
  entries: CorpusEntry[];
}

export interface GenerateOptions {
  seed?: number;
  files?: number;
  /** Output directory; created (and cleared) as needed. */
  out: string;
  /** Regenerate even when an up-to-date manifest already sits in `out`. */
  force?: boolean;
}

export interface GenerateResult {
  dir: string;
  manifest: CorpusManifest;
  /** False when a matching corpus was reused instead of rebuilt. */
  generated: boolean;
}

/** The stable, machine-local default corpus path for a seed/count pair. */
export function defaultCorpusDir(
  seed: number = DEFAULT_SEED,
  files: number = DEFAULT_FILE_COUNT,
): string {
  return join(tmpdir(), "pocket-comb-perf", `corpus-s${seed}-n${files}`);
}

/**
 * Generate (or reuse) a deterministic corpus. Byte-identical for a given
 * `seed` and `files`, regardless of when or where it runs.
 */
export function generateCorpus(options: GenerateOptions): GenerateResult {
  const seed = options.seed ?? DEFAULT_SEED;
  const files = Math.max(1, Math.floor(options.files ?? DEFAULT_FILE_COUNT));
  const out = resolve(options.out);
  const manifestPath = join(out, "manifest.json");

  if (options.force !== true && existsSync(manifestPath)) {
    const existing = readManifest(manifestPath);
    if (existing !== null && existing.seed === seed && existing.files === files) {
      return { dir: out, manifest: existing, generated: false };
    }
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const entries: CorpusEntry[] = [];
  const counts: Record<string, number> = {};
  for (const shape of SHAPES) counts[shape] = 0;

  for (let index = 0; index < files; index++) {
    const shape = SHAPES[index % SHAPES.length]!;
    const name = `f${String(index).padStart(5, "0")}.js`;
    writeFileSync(join(out, name), renderFile(shape, index, perFileRand(seed, index)), "utf8");
    entries.push({ name, shape });
    counts[shape] = (counts[shape] ?? 0) + 1;
  }

  const manifest: CorpusManifest = { schema: 1, seed, files, shapes: counts, entries };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { dir: out, manifest, generated: true };
}

function readManifest(path: string): CorpusManifest | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CorpusManifest;
  } catch {
    return null;
  }
}

// --- deterministic randomness -------------------------------------------------

/** mulberry32: tiny, fast, and byte-reproducible for a fixed 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A per-file stream, so each file's body is independent of the corpus size. */
function perFileRand(seed: number, index: number): () => number {
  return mulberry32((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
}

function ri(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

// --- statement builders -------------------------------------------------------

/** A harmless (used) statement. */
function filler(rand: () => number, index: number, count: number): string[] {
  const out: string[] = [];
  for (let s = 0; s < count; s++) {
    if (rand() < 0.5) {
      out.push(`  const v${index}_${s} = a + b * ${s};`);
      out.push(`  b += v${index}_${s};`);
    } else {
      out.push(`  b += ${s};`);
    }
  }
  return out;
}

/** Exactly `count` violations, alternating the two configured rules. */
function violations(index: number, count: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    if (k % 2 === 0) out.push(`  const w${index}_${k} = a - b * ${k};`); // no-unused-vars
    else out.push(`  console.log("v", ${k});`); // no-console
  }
  return out;
}

/** Deterministically scatter `items` through `base`, preserving each order. */
function mix(rand: () => number, base: string[], items: string[]): string[] {
  const out = [...base];
  for (const item of items) {
    out.splice(Math.floor(rand() * (out.length + 1)), 0, item);
  }
  return out;
}

function wrap(index: number, statements: string[]): string[] {
  return [`export function f${index}(a, b) {`, ...statements, "  return a + b;", "}"];
}

interface Rendered {
  lines: string[];
  eol: "\n" | "\r\n";
  bom: boolean;
}

function renderShape(shape: CorpusShape, index: number, rand: () => number): Rendered {
  const lf: Rendered = { lines: [], eol: "\n", bom: false };
  switch (shape) {
    case "clean":
      return { ...lf, lines: wrap(index, filler(rand, index, ri(rand, 6, 14))) };
    case "sparse-insert":
      return {
        ...lf,
        lines: wrap(
          index,
          mix(rand, filler(rand, index, ri(rand, 6, 12)), violations(index, ri(rand, 1, 2))),
        ),
      };
    case "dense-insert":
      return {
        ...lf,
        lines: wrap(
          index,
          mix(rand, filler(rand, index, ri(rand, 4, 10)), violations(index, ri(rand, 10, 18))),
        ),
      };
    case "next-line-guarded":
      return {
        ...lf,
        lines: wrap(index, [
          ...filler(rand, index, ri(rand, 4, 8)),
          "  // eslint-disable-next-line no-console",
          '  console.log("guarded-next-line");',
          ...violations(index + 1000, ri(rand, 1, 2)),
        ]),
      };
    case "next-line-bare":
      return {
        ...lf,
        lines: wrap(index, [
          ...filler(rand, index, ri(rand, 3, 6)),
          "  // eslint-disable-next-line",
          '  console.log("bare-next-line");',
          ...violations(index + 2000, ri(rand, 1, 2)),
        ]),
      };
    case "line-suffix":
      return {
        ...lf,
        lines: wrap(index, [
          ...filler(rand, index, ri(rand, 3, 6)),
          '  console.log("line-suffix"); // eslint-disable-line no-console -- line form reason',
          ...violations(index + 3000, ri(rand, 1, 2)),
        ]),
      };
    case "line-bare":
      return {
        ...lf,
        lines: wrap(index, [
          ...filler(rand, index, ri(rand, 3, 6)),
          '  console.log("line-bare"); // eslint-disable-line',
          ...violations(index + 4000, ri(rand, 1, 2)),
        ]),
      };
    case "multi-rule":
      return {
        ...lf,
        lines: wrap(index, [
          "  // eslint-disable-next-line no-console, no-unused-vars -- multi rule list",
          '  const m = a - b; console.log("multi-rule");',
          ...filler(rand, index, ri(rand, 3, 6)),
          ...violations(index + 5000, ri(rand, 1, 2)),
        ]),
      };
    case "block-pair":
      return {
        ...lf,
        lines: [
          "/* eslint-disable no-console */",
          ...wrap(index, [
            '  console.log("block-pair-suppressed");',
            ...filler(rand, index, ri(rand, 3, 6)),
            ...violations(index + 6000, ri(rand, 1, 2)),
          ]),
          "/* eslint-enable no-console */",
        ],
      };
    case "file-level":
      return {
        ...lf,
        lines: [
          "/* eslint-disable no-console */",
          ...wrap(index, [
            '  console.log("file-level-suppressed");',
            ...filler(rand, index, ri(rand, 3, 6)),
            ...violations(index + 7000, ri(rand, 1, 2)),
          ]),
        ],
      };
    case "description-suffix":
      return {
        ...lf,
        lines: wrap(index, [
          "  // eslint-disable-next-line no-console -- because the harness says so",
          '  console.log("described");',
          ...filler(rand, index, ri(rand, 3, 6)),
          ...violations(index + 8000, ri(rand, 1, 2)),
        ]),
      };
    case "crlf":
      return {
        lines: wrap(index, [
          "  // eslint-disable-next-line no-console",
          '  console.log("crlf-guarded");',
          ...filler(rand, index, ri(rand, 3, 6)),
          ...violations(index + 9000, ri(rand, 1, 2)),
        ]),
        eol: "\r\n",
        bom: false,
      };
    case "bom":
      return {
        bom: true,
        eol: "\n",
        lines: wrap(index, [
          ...filler(rand, index, ri(rand, 3, 6)),
          ...violations(index + 10000, ri(rand, 2, 4)),
        ]),
      };
    case "long-line":
      return {
        ...lf,
        lines: wrap(index, [
          `  const blob${index} = "${"x".repeat(4000)}";`,
          `  b += blob${index}.length;`,
          ...filler(rand, index, ri(rand, 3, 6)),
          ...violations(index + 11000, ri(rand, 1, 2)),
        ]),
      };
  }
}

function renderFile(shape: CorpusShape, index: number, rand: () => number): string {
  const { lines, eol, bom } = renderShape(shape, index, rand);
  return `${bom ? "\ufeff" : ""}${lines.join(eol)}${eol}`;
}

// --- CLI ----------------------------------------------------------------------

export interface GenerateCliIo {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: GenerateCliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

interface GenerateArgs {
  seed: number;
  files: number;
  out: string;
  force: boolean;
  stress: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): GenerateArgs {
  let seed = DEFAULT_SEED;
  let files = DEFAULT_FILE_COUNT;
  let out: string | undefined;
  let force = false;
  let stress = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--seed") seed = Number(argv[++i]);
    else if (arg === "--files" || arg === "-n") files = Number(argv[++i]);
    else if (arg === "--out" || arg === "-o") out = argv[++i];
    else if (arg === "--stress") stress = true;
    else if (arg === "--force") force = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (stress) files = STRESS_FILE_COUNT;
  if (!Number.isFinite(seed)) throw new Error("--seed must be an integer");
  if (!Number.isFinite(files) || files < 1) throw new Error("--files must be a positive integer");
  return { seed, files, out: out ?? defaultCorpusDir(seed, files), force, stress, help };
}

const USAGE = `Usage: npm run perf:generate -- [--files <n> | --stress] [--seed <n>] [--out <dir>] [--force]

Generates the deterministic perf corpus (same seed => byte-identical). Defaults to
${DEFAULT_FILE_COUNT} files (--stress => ${STRESS_FILE_COUNT}) under the OS temp dir.`;

export function runGenerateCli(argv: string[], io: GenerateCliIo = consoleIo): number {
  let args: GenerateArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  const result = generateCorpus({
    seed: args.seed,
    files: args.files,
    out: args.out,
    ...(args.force ? { force: true } : {}),
  });
  io.out(
    `corpus: ${result.manifest.files} files at ${result.dir} ` +
      `(seed ${result.manifest.seed}, ${result.generated ? "generated" : "reused"})`,
  );
  return 0;
}

const isEntry =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  process.exitCode = runGenerateCli(process.argv.slice(2));
}
