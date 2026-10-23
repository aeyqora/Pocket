/**
 * The shared full-file directive scan (spec §7): one pass over a file's lines
 * that recognises **every** suppression directive across all four forms —
 * `next-line`, `line`, `block`, and `file-level` — and returns a structured
 * representation rich enough for strip (remove/cleanup), rename (replace), and
 * census (inventory). It is the per-action scan strategy the non-lazy actions
 * share; the suppress default stays lazy (spec §6.1, §7).
 *
 * Cost is the point: the scan is the work for remove/replace/cleanup/inventory
 * and must land at µs-per-file scale. A cheap `includes("eslint-")` fast path
 * keeps ordinary source lines out of the regexes, and pairing is a single linear
 * walk over the handful of directives a file actually contains.
 *
 * **Spelling is part of the grammar.** A directive may be written `// ...`,
 * `/* ... *\/`, `{/* ... *\/}`, or `{ /* ... *\/ }` (the last two are JSX
 * children). The scan stores the exact opener and closer so a rewrite
 * (`formatDirective`, prepend) keeps the original spelling instead of
 * normalising it. Rewriting a JSX directive as `//` would turn it into rendered
 * text, so spelling is semantic, not cosmetic.
 *
 * `scan.ts` deliberately imports nothing from `engine.ts`: the engine imports
 * *this* module (the remove strategy and the shared `splitRuleList`), so the
 * dependency arrow points one way.
 */
import type { DirectiveForm } from "./types.js";

/** The directive's rule list plus its optional trailing `-- description`. */
export interface RuleList {
  rules: string[];
  desc: string;
  bare: boolean;
}

/**
 * Split a directive's tail into its rule list and optional `-- description`
 * (spec §6.1): the description is whatever follows the first `--`, and the rule
 * list is the comma-separated tokens before it. `bare` means no rules listed.
 */
export function splitRuleList(rest: string): RuleList {
  let tail = rest;
  let desc = "";
  const separator = tail.indexOf("--");
  if (separator >= 0) {
    desc = tail.slice(separator + 2).trim();
    tail = tail.slice(0, separator);
  }
  const rules = tail
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return { rules, desc, bare: rules.length === 0 };
}

/**
 * One directive found by the full-file scan. Everything a consumer needs to
 * strip a rule, rename a token, or count a census entry without re-parsing.
 */
export interface ScannedDirective {
  /** 1-based line the directive sits on (the ledger's anchor). */
  line: number;
  /** 0-based line index into the split text. */
  index: number;
  /** The directive's form (spec §6). */
  form: DirectiveForm;
  /** Whether the directive disables rules or re-enables them (a block closer). */
  kind: "disable" | "enable";
  /** Rule tokens listed, in order (empty when bare). */
  rules: string[];
  /** Trailing `-- description` text, trimmed (no leading `-- `). */
  description: string;
  /** True when the directive names no rules. */
  bare: boolean;
  /** `line`-form suffix directives: the code preceding the comment; else "". */
  code: string;
  /** Suffix directives: the exact whitespace between code and comment; else "". */
  sep: string;
  /** Whole-line directives: the leading whitespace; else "". */
  indent: string;
  /** True when the comment rides at the end of a code line (suffix form). */
  suffix: boolean;
  /** The comment's exact opener: `//`, `/*`, `{/*`, or `{ /*`. */
  open: string;
  /** The comment's exact closer, including its leading whitespace; "" for `//`. */
  close: string;
  /** The line's text without a trailing CR. */
  text: string;
  /** The line ended in CRLF. */
  cr: boolean;
  /**
   * A `block`-form disable: the 1-based line of the `eslint-enable` that closes
   * it. Absent on `file-level` disables (no closer) and non-block forms.
   */
  pairLine?: number;
  /**
   * An `eslint-enable`: the 1-based lines of the disables it closes. Absent when
   * it closes nothing (an orphan enable).
   */
  closes?: number[];
}

/** A matched directive before block pairing assigns `block`/`file-level`. */
export interface DirectiveMatch {
  form: "next-line" | "line" | "block";
  kind: "disable" | "enable";
  rules: string[];
  description: string;
  bare: boolean;
  code: string;
  sep: string;
  indent: string;
  suffix: boolean;
  open: string;
  close: string;
}

// One grammar per comment style, shared by the full-file scan and the suppress
// lazy scan. `disable(?!-)` excludes the `-next-line`/`-line` suffixes when the
// short `disable` alternative is tried. The block/JSX patterns require their
// closer, so a malformed line is not half-recognised. Multi-line block
// directives (`/*` newline `eslint-disable` ...) are deliberately out of scope.
const KEYWORD = String.raw`(eslint-(?:disable-next-line|disable-line|disable(?!-)|enable)\b)`;

const WHOLE_SLASH_RE = new RegExp(String.raw`^(\s*)(\/\/)\s*${KEYWORD}\s*(.*?)\s*$`);
const WHOLE_BLOCK_RE = new RegExp(String.raw`^(\s*)(\/\*)\s*${KEYWORD}\s*(.*?)(\s*\*\/)\s*$`);
const WHOLE_JSX_RE = new RegExp(String.raw`^(\s*)(\{\s*\/\*)\s*${KEYWORD}\s*(.*?)(\s*\*\/\s*\})\s*$`);

// Suffix forms allow zero whitespace before the comment: `code();// ...` and
// `</div>{/* ... */}` are both valid and must not be missed. The separator is
// captured so a rewrite keeps the original spacing too.
const SUFFIX_SLASH_RE = new RegExp(String.raw`^(\s*.*\S)(\s*)(\/\/)\s*${KEYWORD}\s*(.*?)\s*$`);
const SUFFIX_BLOCK_RE = new RegExp(
  String.raw`^(\s*.*\S)(\s*)(\/\*)\s*${KEYWORD}\s*(.*?)(\s*\*\/)\s*$`,
);
const SUFFIX_JSX_RE = new RegExp(
  String.raw`^(\s*.*\S)(\s*)(\{\s*\/\*)\s*${KEYWORD}\s*(.*?)(\s*\*\/\s*\})\s*$`,
);

/** Strip one trailing CR (CRLF files keep the CR on the stored line). */
export function stripCr(line: string): { probe: string; cr: boolean } {
  return line.endsWith("\r") ? { probe: line.slice(0, -1), cr: true } : { probe: line, cr: false };
}

/** Turn a regex match into the shared directive shape. */
function matched(
  m: RegExpExecArray,
  style: "slash" | "block" | "jsx",
  suffix: boolean,
): DirectiveMatch {
  const prefix = m[1] ?? "";
  // Whole-line matches are (prefix, open, keyword, tail[, close]); suffix
  // matches insert the separator between the code prefix and the open.
  const sep = suffix ? (m[2] ?? "") : "";
  const open = suffix ? (m[3] ?? "") : (m[2] ?? "");
  const keyword = suffix ? (m[4] ?? "") : (m[3] ?? "");
  const tail = suffix ? (m[5] ?? "") : (m[4] ?? "");
  const close = style === "slash" ? "" : (m[suffix ? 6 : 5] ?? "");
  const { rules, desc, bare } = splitRuleList(tail);

  let form: DirectiveMatch["form"];
  let kind: DirectiveMatch["kind"];
  if (keyword === "eslint-enable") {
    form = "block";
    kind = "enable";
  } else if (keyword === "eslint-disable-next-line") {
    form = "next-line";
    kind = "disable";
  } else if (keyword === "eslint-disable-line") {
    form = "line";
    kind = "disable";
  } else {
    form = "block";
    kind = "disable";
  }

  return {
    form,
    kind,
    rules,
    description: desc,
    bare,
    code: suffix ? prefix : "",
    sep,
    indent: suffix ? "" : prefix,
    suffix,
    open,
    close,
  };
}

/**
 * Match a directive that occupies the whole line (indent + comment only). The
 * suppress lazy scan uses this for the `next-line` guard on the line above; the
 * full-file scan uses it for every form.
 */
export function matchWholeLine(probe: string): DirectiveMatch | null {
  // Fast path: no directive keyword on the line, no regex work at all. Ordinary
  // source lines dominate a file, so this is what keeps the scan µs-scale.
  if (!probe.includes("eslint-")) return null;

  let m = WHOLE_SLASH_RE.exec(probe);
  if (m !== null) return matched(m, "slash", false);
  m = WHOLE_BLOCK_RE.exec(probe);
  if (m !== null) return matched(m, "block", false);
  m = WHOLE_JSX_RE.exec(probe);
  if (m !== null) return matched(m, "jsx", false);
  return null;
}

/**
 * Match a directive riding at the end of a code line. Every comment style is
 * recognised, including JSX `code {/* ... *\/}` and the block-comment
 * `code /* eslint-disable-line ... *\/` suffix forms.
 */
export function matchSuffix(probe: string): DirectiveMatch | null {
  if (!probe.includes("eslint-")) return null;

  // A whole-line JSX directive (`{/* ... */}`) can look like a block-comment
  // suffix with `{` as the code prefix. It is a whole-line directive, so never
  // report it as a suffix (the full-file scan tries whole-line first anyway).
  const wholeLineJsx = (match: DirectiveMatch | null): DirectiveMatch | null =>
    match !== null && match.code.trim() === "{" ? null : match;

  let m = SUFFIX_SLASH_RE.exec(probe);
  if (m !== null) return wholeLineJsx(matched(m, "slash", true));
  m = SUFFIX_BLOCK_RE.exec(probe);
  if (m !== null) return wholeLineJsx(matched(m, "block", true));
  m = SUFFIX_JSX_RE.exec(probe);
  if (m !== null) return wholeLineJsx(matched(m, "jsx", true));
  return null;
}

/**
 * Does an `eslint-enable` close a block-open disable? A bare enable re-enables
 * everything; a bare disable suppresses everything, so any enable naming rules
 * closes it for those rules. Otherwise the rule sets must intersect.
 */
function closes(disable: ScannedDirective, enable: ScannedDirective): boolean {
  if (enable.bare || disable.bare) return true;
  return disable.rules.some((rule) => enable.rules.includes(rule));
}

/**
 * Walk the directives once, matching each `eslint-enable` to the still-open
 * block-opens it closes (the simple 1:1 pairing the spec's block model assumes).
 * A disable with no closing enable is a `file-level` directive. Matching is
 * linear: the open list only ever holds directives a later enable can close.
 */
function pairBlocks(found: ScannedDirective[]): void {
  const candidates = new Set<ScannedDirective>();
  for (const directive of found) {
    if (directive.kind === "disable" && directive.form === "block") candidates.add(directive);
  }
  if (candidates.size === 0) return;

  const open: ScannedDirective[] = [];
  for (const directive of found) {
    if (candidates.has(directive)) {
      open.push(directive);
      continue;
    }
    if (directive.kind !== "enable" || open.length === 0) continue;
    const matchedOpens = open.filter((disable) => closes(disable, directive));
    if (matchedOpens.length === 0) continue;
    directive.closes = matchedOpens.map((disable) => disable.line);
    for (const disable of matchedOpens) {
      disable.pairLine = directive.line;
      open.splice(open.indexOf(disable), 1);
    }
  }

  for (const disable of candidates) {
    if (disable.pairLine === undefined) disable.form = "file-level";
  }
}

/** The full-file directive scan over all four forms (spec §7). */
export function scanDirectives(lines: readonly string[]): ScannedDirective[] {
  const found: ScannedDirective[] = [];
  for (let index = 0; index < lines.length; index++) {
    const { probe, cr } = stripCr(lines[index] ?? "");
    const matchedLine = matchWholeLine(probe) ?? matchSuffix(probe);
    if (matchedLine === null) continue;
    found.push({ ...matchedLine, line: index + 1, index, text: probe, cr });
  }
  pairBlocks(found);
  return found;
}

/** The directive keyword for a scan result, used when a rewrite keeps its form. */
export function directiveName(directive: ScannedDirective): string {
  if (directive.kind === "enable") return "eslint-enable";
  switch (directive.form) {
    case "next-line":
      return "eslint-disable-next-line";
    case "line":
      return "eslint-disable-line";
    default:
      return "eslint-disable";
  }
}

/**
 * Re-render a scanned directive with a new rule list, preserving its form,
 * comment spelling, code prefix/indent, trailing description, and CR. The
 * caller deletes the line instead of calling this when the list would empty
 * (spec §6.3: never leave a bare `eslint-disable`).
 */
export function formatDirective(directive: ScannedDirective, rules: readonly string[]): string {
  const name = directiveName(directive);
  const list = rules.join(", ");
  const body = list.length === 0 ? name : `${name} ${list}`;
  const desc = directive.description ? ` -- ${directive.description}` : "";
  const cr = directive.cr ? "\r" : "";
  const prefix = directive.suffix ? `${directive.code}${directive.sep}` : directive.indent;
  return `${prefix}${directive.open} ${body}${desc}${directive.close}${cr}`;
}
