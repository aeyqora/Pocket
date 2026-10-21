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
  /** Whole-line directives: the leading whitespace; else "". */
  indent: string;
  /** True when the comment rides at the end of a code line (suffix form). */
  suffix: boolean;
  /** The comment's spelling, preserved so a rewrite keeps it. */
  comment: "//" | "/*";
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

// Whole-line comment directives: the line is (indent +) a comment and nothing
// else. `eslint-disable(?!-)` excludes the `-next-line`/`-line` suffixes.
// `WHOLE_NEXT_LINE_RE` is also the suppress lazy scan's guard matcher, so it is
// exported: one grammar definition for both scans (engine.ts imports it).
export const WHOLE_NEXT_LINE_RE =
  /^(\s*)(\/\/|\/\*)\s*eslint-disable-(next-line|line)\b\s*(.*?)\s*(?:\*\/)?\s*$/;
const WHOLE_DISABLE_RE = /^(\s*)(\/\/|\/\*)\s*eslint-disable(?!-)\b\s*(.*?)\s*(?:\*\/)?\s*$/;
const WHOLE_ENABLE_RE = /^(\s*)(\/\/|\/\*)\s*eslint-enable\b\s*(.*?)\s*(?:\*\/)?\s*$/;

// Suffix directives: a comment riding at the end of a code line.
export const SUFFIX_LINE_RE = /^(\s*.*\S)\s+\/\/\s*eslint-disable-line\b\s*(.*)$/;
const SUFFIX_DISABLE_RE =
  /^(\s*.*\S)\s+(\/\/|\/\*)\s*eslint-disable(?!-)\b\s*(.*?)\s*(?:\*\/)?\s*$/;
const SUFFIX_ENABLE_RE = /^(\s*.*\S)\s+(\/\/|\/\*)\s*eslint-enable\b\s*(.*?)\s*(?:\*\/)?\s*$/;

/** Strip one trailing CR (CRLF files keep the CR on the stored line). */
export function stripCr(line: string): { probe: string; cr: boolean } {
  return line.endsWith("\r") ? { probe: line.slice(0, -1), cr: true } : { probe: line, cr: false };
}

interface Matched {
  form: DirectiveForm;
  kind: "disable" | "enable";
  rules: string[];
  description: string;
  bare: boolean;
  code: string;
  indent: string;
  suffix: boolean;
  comment: "//" | "/*";
}

function matchLine(probe: string): Matched | null {
  // Fast path: no directive keyword on the line, no regex work at all. Ordinary
  // source lines dominate a file, so this is what keeps the scan µs-scale.
  if (!probe.includes("eslint-")) return null;

  let m = WHOLE_NEXT_LINE_RE.exec(probe);
  if (m !== null) {
    const { rules, desc, bare } = splitRuleList(m[4] ?? "");
    return {
      form: m[3] === "line" ? "line" : "next-line",
      kind: "disable",
      rules,
      description: desc,
      bare,
      code: "",
      indent: m[1] ?? "",
      suffix: false,
      comment: m[2] === "/*" ? "/*" : "//",
    };
  }

  m = WHOLE_DISABLE_RE.exec(probe);
  if (m !== null) {
    const { rules, desc, bare } = splitRuleList(m[3] ?? "");
    return {
      form: "block",
      kind: "disable",
      rules,
      description: desc,
      bare,
      code: "",
      indent: m[1] ?? "",
      suffix: false,
      comment: m[2] === "/*" ? "/*" : "//",
    };
  }

  m = WHOLE_ENABLE_RE.exec(probe);
  if (m !== null) {
    const { rules, desc, bare } = splitRuleList(m[3] ?? "");
    return {
      form: "block",
      kind: "enable",
      rules,
      description: desc,
      bare,
      code: "",
      indent: m[1] ?? "",
      suffix: false,
      comment: m[2] === "/*" ? "/*" : "//",
    };
  }

  m = SUFFIX_LINE_RE.exec(probe);
  if (m !== null) {
    const { rules, desc, bare } = splitRuleList(m[2] ?? "");
    return {
      form: "line",
      kind: "disable",
      rules,
      description: desc,
      bare,
      code: m[1] ?? "",
      indent: "",
      suffix: true,
      comment: "//",
    };
  }

  m = SUFFIX_DISABLE_RE.exec(probe);
  if (m !== null) {
    const { rules, desc, bare } = splitRuleList(m[3] ?? "");
    return {
      form: "block",
      kind: "disable",
      rules,
      description: desc,
      bare,
      code: m[1] ?? "",
      indent: "",
      suffix: true,
      comment: m[2] === "/*" ? "/*" : "//",
    };
  }

  m = SUFFIX_ENABLE_RE.exec(probe);
  if (m !== null) {
    const { rules, desc, bare } = splitRuleList(m[3] ?? "");
    return {
      form: "block",
      kind: "enable",
      rules,
      description: desc,
      bare,
      code: m[1] ?? "",
      indent: "",
      suffix: true,
      comment: m[2] === "/*" ? "/*" : "//",
    };
  }

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
    const matched = open.filter((disable) => closes(disable, directive));
    if (matched.length === 0) continue;
    directive.closes = matched.map((disable) => disable.line);
    for (const disable of matched) {
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
    const matched = matchLine(probe);
    if (matched === null) continue;
    found.push({ ...matched, line: index + 1, index, text: probe, cr });
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
  const close = directive.comment === "/*" ? " */" : "";
  const cr = directive.cr ? "\r" : "";
  const prefix = directive.suffix ? `${directive.code} ` : directive.indent;
  return `${prefix}${directive.comment} ${body}${desc}${close}${cr}`;
}
