import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIfPresent, readProtectedDocument } from "../src/protected-document.js";
import { defectsOf } from "../src/finding.js";
import { PROTECTED_REGISTRY } from "../src/validate.js";


/**
 * A repo-shaped directory to read out of. Removed on exit, so a test that
 * replaces a file with a directory cannot leave one behind.
 */
function root(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pz-protected-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("protected-document: absent and unreadable are different things", () => {
  it("reads a file that is there, and reports one that is not as absent", () => {
    const r = root();
    try {
      mkdirSync(join(r.dir, ".pocket-zipper"));
      const path = join(".pocket-zipper", "config.yml");
      assert.equal(readIfPresent(r.dir, path), null, "nothing written yet");

      writeFileSync(join(r.dir, path), "enabled: true\n");
      assert.equal(readIfPresent(r.dir, path), "enabled: true\n");

      const read = readProtectedDocument(r.dir, path);
      assert.equal(read.raw, "enabled: true\n");
      assert.equal(read.defect, null);
    } finally {
      r.cleanup();
    }
  });

  it("reports a genuinely absent file as absent, with no defect", () => {
    const r = root();
    try {
      const read = readProtectedDocument(r.dir, PROTECTED_REGISTRY);
      assert.equal(read.raw, null);
      assert.equal(read.defect, null);
    } finally {
      r.cleanup();
    }
  });

  it("reports a file that is there but unreadable as a defect, not an absence", () => {
    const r = root();
    try {
      // A directory in the file's place is an unreadable document needing no
      // permission games, and is the shape this guard exists for: the path
      // resolves, so it is not "absent".
      mkdirSync(join(r.dir, PROTECTED_REGISTRY), { recursive: true });
      const read = readProtectedDocument(r.dir, PROTECTED_REGISTRY);
      assert.equal(read.raw, null);
      assert.ok(read.defect, "a directory where a file should be is a defect");
      assert.match(read.defect.message, /could not be read/);
      assert.equal(defectsOf([read.defect]).length, 1, "a read failure is a defect, not hygiene");
    } finally {
      r.cleanup();
    }
  });

  it("locates the finding on the document it could not read", () => {
    const r = root();
    try {
      mkdirSync(join(r.dir, ".pocket-zipper", "config.yml"), { recursive: true });
      const read = readProtectedDocument(r.dir, ".pocket-zipper/config.yml");
      assert.ok(read.defect);
      // `documentDefect` carries the path as the finding's own field, and the
      // renderer prints it — the message itself names only the errno, so that
      // the path is not printed twice on one line.
      assert.equal(read.defect.path, ".pocket-zipper/config.yml");
      assert.equal(read.defect.message, "the document could not be read (EISDIR)");
    } finally {
      r.cleanup();
    }
  });
});
