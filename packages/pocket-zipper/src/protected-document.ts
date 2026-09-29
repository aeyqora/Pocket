import { readFileSync } from "node:fs";
import { join } from "node:path";
import { documentDefect, type Finding } from "./validate.js";

/**
 * How this tool reads a file it depends on, keeping *absent* and *unreadable*
 * apart.
 *
 * A file that is genuinely not there is a clean state: a repo with no
 * `.pocket-zipper/exceptions.yml` yet has an empty registry, and the write
 * creates one. A file that is there and cannot be read is a **registry defect** —
 * a permissions error, a directory where a file should be — and fails closed
 * wherever it is read, with a precise diagnostic.
 *
 * `validate` and the authoring session both need this judgment and both used to
 * spell it out separately, down to the sentence reporting it.
 */

/** A file's text, or null when it is not there at all. Throws on any other failure. */
export function readIfPresent(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

export interface ProtectedDocument {
  /** The file's text, or null when it is genuinely not there. */
  readonly raw: string | null;
  /**
   * The defect finding when the file is there and could not be read; null for
   * both a clean read and a file that is merely absent.
   */
  readonly defect: Finding | null;
}

/**
 * A protected document, read so that an unreadable one is a defect rather than
 * an absent one. The caller decides what a defect means for it: `validate`
 * collects findings and reports them in its two tiers, the authoring session
 * refuses outright. That difference is deliberate and stays with the caller —
 * what they share is that neither treats the failure as a clean repository.
 */
export function readProtectedDocument(root: string, path: string): ProtectedDocument {
  try {
    return { raw: readIfPresent(root, path), defect: null };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? "unknown error";
    return { raw: null, defect: documentDefect(path, `the document could not be read (${code})`) };
  }
}
