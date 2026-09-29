/**
 * The two protected files: the **Policy** document and the **Exception
 * registry**.
 *
 * They live here rather than in the validator that reads them, because a path is
 * not a fact about a file's grammar. Every surface that governs, reads, or
 * reports on them needs the name — the gate, the validator, the cleanup
 * pointers, the authoring session — and putting the names in the validator meant
 * four modules imported a parsing module to learn a filename.
 */
export const PROTECTED_CONFIG = ".pocket-zipper/config.yml";
export const PROTECTED_REGISTRY = ".pocket-zipper/exceptions.yml";
