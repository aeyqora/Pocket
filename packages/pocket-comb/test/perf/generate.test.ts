import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FILE_COUNT,
  DEFAULT_SEED,
  SHAPES,
  STRESS_FILE_COUNT,
  generateCorpus,
  type CorpusManifest,
} from "../../perf/generate.js";
import { cleanupTemps, tempDir } from "../harness.js";

after(cleanupTemps);

/** sha256 of every generated file plus the manifest, keyed by base name. */
function fingerprint(dir: string, manifest: CorpusManifest): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const entry of manifest.entries) {
    const bytes = readFileSync(join(dir, entry.name));
    hashes.set(entry.name, createHash("sha256").update(bytes).digest("hex"));
  }
  hashes.set(
    "manifest.json",
    createHash("sha256").update(readFileSync(join(dir, "manifest.json"))).digest("hex"),
  );
  return hashes;
}

/** The first file carrying each shape, so shape content can be asserted. */
function firstByShape(dir: string, manifest: CorpusManifest): Map<string, string> {
  const seen = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (!seen.has(entry.shape)) {
      seen.set(entry.shape, readFileSync(join(dir, entry.name), "utf8"));
    }
  }
  return seen;
}

function count(haystack: string, pattern: RegExp): number {
  return haystack.match(pattern)?.length ?? 0;
}

test("same seed produces a byte-identical corpus", () => {
  const a = generateCorpus({ seed: 1234, files: 96, out: join(tempDir("pc-gen-a-"), "corpus") });
  const b = generateCorpus({ seed: 1234, files: 96, out: join(tempDir("pc-gen-b-"), "corpus") });
  assert.deepEqual(fingerprint(b.dir, b.manifest), fingerprint(a.dir, a.manifest));

  const other = generateCorpus({
    seed: 4321,
    files: 96,
    out: join(tempDir("pc-gen-c-"), "corpus"),
  });
  assert.notDeepEqual(fingerprint(other.dir, other.manifest), fingerprint(a.dir, a.manifest));
});

test("regenerating in place is byte-identical and reuses a matching manifest", () => {
  const out = join(tempDir("pc-gen-inplace-"), "corpus");
  const first = generateCorpus({ seed: DEFAULT_SEED, files: 48, out });
  const before = fingerprint(first.dir, first.manifest);
  const second = generateCorpus({ seed: DEFAULT_SEED, files: 48, out });
  assert.equal(second.generated, false, "a matching manifest reuses the corpus");
  assert.deepEqual(fingerprint(second.dir, second.manifest), before);
  const forced = generateCorpus({ seed: DEFAULT_SEED, files: 48, out, force: true });
  assert.equal(forced.generated, true);
  assert.deepEqual(fingerprint(forced.dir, forced.manifest), before);
});

test("generates exactly the requested file count and records the seed", () => {
  const { dir, manifest } = generateCorpus({
    seed: DEFAULT_SEED,
    files: 25,
    out: join(tempDir("pc-gen-count-"), "corpus"),
  });
  assert.equal(manifest.files, 25);
  assert.equal(manifest.seed, DEFAULT_SEED);
  assert.equal(manifest.entries.length, 25);
  for (const entry of manifest.entries) {
    assert.ok(existsSync(join(dir, entry.name)), `${entry.name} exists on disk`);
  }
});

test("scale defaults match the spec: 2,000 default / 20,000 stress", () => {
  assert.equal(DEFAULT_FILE_COUNT, 2000);
  assert.equal(STRESS_FILE_COUNT, 20000);
});

test("packs every listed shape", () => {
  const { dir, manifest } = generateCorpus({
    seed: DEFAULT_SEED,
    files: SHAPES.length * 3,
    out: join(tempDir("pc-gen-shapes-"), "corpus"),
  });

  for (const shape of SHAPES) {
    assert.ok((manifest.shapes[shape] ?? 0) > 0, `manifest records shape ${shape}`);
  }

  const byShape = firstByShape(dir, manifest);
  // Independent content expectations per shape (spec §11 checklist).
  const expectations: Record<string, (text: string) => void> = {
    clean: (text) => {
      assert.equal(count(text, /eslint-disable/g), 0, "clean has no directive");
      assert.equal(count(text, /console\.log/g), 0, "clean has no violation");
      assert.equal(count(text, /\bw\d+_\d+\b/g), 0, "clean has no unused binding");
    },
    "sparse-insert": (text) => {
      assert.equal(count(text, /eslint-disable/g), 0, "sparse has no directive");
      const violations = count(text, /console\.log|const w\d+_/g);
      assert.ok(violations > 0 && violations <= 3, `sparse is sparse (${violations})`);
    },
    "dense-insert": (text) => {
      assert.equal(count(text, /eslint-disable/g), 0, "dense has no directive");
      const violations = count(text, /console\.log|const w\d+_/g);
      assert.ok(violations >= 8, `dense is dense (${violations})`);
    },
    "next-line-guarded": (text) => {
      assert.match(text, /\/\/ eslint-disable-next-line no-console/);
    },
    "next-line-bare": (text) => {
      assert.match(text, /\/\/ eslint-disable-next-line\s*$/m, "bare next-line guard");
    },
    "line-suffix": (text) => {
      assert.match(text, /console\.log\([^\n]*\);[ \t]*\/\/ eslint-disable-line no-console/);
    },
    "line-bare": (text) => {
      assert.match(text, /\/\/ eslint-disable-line\s*$/m, "bare line guard");
    },
    "multi-rule": (text) => {
      assert.match(text, /eslint-disable-next-line no-console, no-unused-vars/);
    },
    "block-pair": (text) => {
      assert.match(text, /\/\* eslint-disable no-console \*\//);
      assert.match(text, /\/\* eslint-enable no-console \*\//);
    },
    "file-level": (text) => {
      assert.match(text, /^\/\* eslint-disable no-console \*\/$/m);
      assert.equal(count(text, /eslint-enable/g), 0, "file-level has no enable");
    },
    "description-suffix": (text) => {
      assert.match(text, /eslint-disable-[a-z-]+ [^\n]* -- \S/);
    },
    crlf: (text) => {
      assert.ok(text.includes("\r\n"), "crlf file uses CRLF endings");
      assert.match(text, /\/\/ eslint-disable-next-line no-console/);
    },
    bom: (text) => {
      assert.equal(text.charCodeAt(0), 0xfeff, "bom file starts with a BOM");
    },
    "long-line": (text) => {
      assert.ok(
        text.split(/\r?\n/).some((line) => line.length > 2000),
        "long-line file carries a very long line",
      );
    },
  };

  for (const shape of SHAPES) {
    const text = byShape.get(shape);
    assert.ok(text !== undefined, `corpus contains shape ${shape}`);
    expectations[shape]!(text!);
  }
});

test("generated files are non-empty and use the .js extension", () => {
  const { dir, manifest } = generateCorpus({
    seed: DEFAULT_SEED,
    files: SHAPES.length,
    out: join(tempDir("pc-gen-ext-"), "corpus"),
  });
  for (const entry of manifest.entries) {
    assert.ok(entry.name.endsWith(".js"), `${entry.name} is a .js file`);
    assert.ok(statSync(join(dir, entry.name)).size > 0, `${entry.name} is non-empty`);
  }
});
