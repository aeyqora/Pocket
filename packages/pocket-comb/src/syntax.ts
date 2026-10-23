/**
 * Syntax context for **inserted** directives (spec §6.1, §7).
 *
 * The style of a new suppression comment depends on where the line sits:
 *
 * - ordinary JS/TS statement position (including a JSX opening tag between
 *   attributes) accepts `// eslint-disable-next-line ...`;
 * - JSX children require `{/* eslint-disable-next-line ... *\/}`, because a
 *   `//` line there is rendered text, not a comment;
 * - inside a template literal, a multi-line string, or a comment there is no
 *   line a directive can be inserted on, so the line is not actionable.
 *
 * This cannot be decided from the text alone (the same line can be JS, JSX
 * children, or template content depending on parser state), so the resolver
 * parses the file with the **configured parser** and classifies the insertion
 * point — the start of the violation line — from the innermost AST node
 * covering it. Parsing is lazy: the worker builds a resolver for a file, but
 * the parser only runs when the engine actually needs to insert.
 */
/** The two insertion styles a violation line can support. */
export type InsertContext = "js" | "jsx-child";

/** The resolver's answer for one line. */
export type LineSyntax =
  | { context: InsertContext }
  | { context: "not-actionable"; reason: string };

/**
 * A synchronous per-line classifier. `runBatch` builds one from the resolved
 * parser configuration; the engine calls it only when an insert is planned.
 */
export type LineSyntaxResolver = (line: number) => LineSyntax;

/** The parser surface ESLint requires (`parseForESLint` preferred). */
export interface ParserLike {
  parse?: (text: string, options: Record<string, unknown>) => unknown;
  parseForESLint?: (
    text: string,
    options: Record<string, unknown>,
  ) => { ast?: unknown } | undefined;
}

/** The resolved `languageOptions` a classifier needs. */
export interface SyntaxLanguageOptions {
  parser?: ParserLike;
  parserOptions?: Record<string, unknown>;
  ecmaVersion?: number | string;
  sourceType?: string;
}

/** The AST shape the classifier walks (a deliberately small structural view). */
interface SyntaxNode {
  type: string;
  range: [number, number];
  [key: string]: unknown;
}

/** True for an ESTree-like node with a valid `[start, end]` range. */
function isNode(value: unknown): value is SyntaxNode {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; range?: unknown };
  if (typeof candidate.type !== "string" || !Array.isArray(candidate.range)) return false;
  const [start, end] = candidate.range;
  return typeof start === "number" && typeof end === "number";
}

/** 0-based offsets of every line start in `source`. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/** The not-actionable answer, with a human-readable reason. */
function notActionable(reason: string): LineSyntax {
  return { context: "not-actionable", reason };
}

/**
 * Find the innermost node that **strictly** contains `offset`. Strict
 * containment matters at boundaries: a line that starts exactly at a JSX child
 * element's `range[0]` is inserted *before* that child, so the enclosing parent
 * (usually a JSX element or fragment) decides the context.
 */
function deepestStrictNode(ast: SyntaxNode, offset: number): SyntaxNode | undefined {
  let best: SyntaxNode | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  const seen = new WeakSet<object>();

  const visit = (node: SyntaxNode): void => {
    const [start, end] = node.range;
    if (offset < start || offset > end) return;
    if (start < offset && offset < end) {
      const span = end - start;
      // `<=` prefers a child over a parent when ranges are identical.
      if (span <= bestSpan) {
        best = node;
        bestSpan = span;
      }
    }
    if (seen.has(node)) return;
    seen.add(node);
    for (const key of Object.keys(node)) {
      if (
        key === "parent" ||
        key === "tokens" ||
        key === "comments" ||
        key === "loc" ||
        key === "range"
      ) {
        continue;
      }
      const value = (node as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) visit(child);
      } else if (isNode(value)) {
        visit(value);
      }
    }
  };

  visit(ast);
  return best;
}

/** True when `offset` sits strictly inside a comment's range. */
function insideComment(ast: SyntaxNode, offset: number): boolean {
  const comments = (ast as Record<string, unknown>).comments;
  if (!Array.isArray(comments)) return false;
  for (const comment of comments) {
    if (!isNode(comment)) continue;
    const [start, end] = comment.range;
    if (start < offset && offset < end) return true;
  }
  return false;
}

/** Map the innermost containing node to an insertion style. */
function classify(node: SyntaxNode | undefined): LineSyntax {
  if (node === undefined) return { context: "js" };
  switch (node.type) {
    case "TemplateElement":
    case "TemplateLiteral":
      return notActionable("inside a template literal");
    case "Literal":
      return notActionable(
        typeof node.regex === "object" && node.regex !== null
          ? "inside a regular expression literal"
          : "inside a string literal",
      );
    case "JSXText":
    case "JSXElement":
    case "JSXFragment":
      return { context: "jsx-child" };
    default:
      // JSXOpeningElement/JSXAttribute are JS positions for a whole-line `//`
      // comment (valid between attributes), and every other node is JS/TS.
      return { context: "js" };
  }
}

/**
 * Build a lazy line classifier from a file's resolved parser configuration.
 * The parser runs at most once, on the first `classify` call; a file whose
 * violations are all already guarded is never parsed.
 */
export function createLineSyntaxResolver(
  text: string,
  languageOptions: SyntaxLanguageOptions | undefined,
  filePath: string,
): LineSyntaxResolver {
  // ESLint strips a BOM and rewrites a leading shebang before parsing; mirror
  // both so offsets line up. Line numbers are unchanged, and edits still apply
  // to the original text.
  const source = (text.startsWith("\uFEFF") ? text.slice(1) : text).replace(/^#!/, "//");
  const starts = lineStarts(source);
  let parsed: { ast: SyntaxNode } | { reason: string } | undefined;

  const parseOnce = (): { ast: SyntaxNode } | { reason: string } => {
    if (parsed !== undefined) return parsed;
    const configured = languageOptions;
    const parser = configured?.parser;
    if (configured === undefined || parser === undefined || parser === null) {
      parsed = { reason: "no JavaScript parser is configured for this file" };
      return parsed;
    }

    // Mirror ESLint's own parse options (`languages/js/index.js`): parserOptions
    // may override the defaults, then ESLint forces location/range/tokens.
    const options: Record<string, unknown> = {
      ecmaVersion: configured.ecmaVersion ?? "latest",
      sourceType: configured.sourceType ?? "module",
      ...(configured.parserOptions ?? {}),
      loc: true,
      range: true,
      tokens: true,
      comment: true,
      filePath,
    };

    try {
      let ast: unknown;
      if (typeof parser.parseForESLint === "function") {
        ast = parser.parseForESLint(source, options)?.ast;
      } else if (typeof parser.parse === "function") {
        ast = parser.parse(source, options);
      } else {
        parsed = { reason: "the configured parser exposes neither parse nor parseForESLint" };
        return parsed;
      }
      if (!isNode(ast)) {
        parsed = { reason: "the configured parser returned no syntax tree" };
        return parsed;
      }
      parsed = { ast };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      parsed = { reason: `the file could not be parsed: ${detail}` };
    }
    return parsed;
  };

  return (line: number): LineSyntax => {
    const result = parseOnce();
    if ("reason" in result) return notActionable(result.reason);

    const offset = starts[line - 1];
    if (offset === undefined) return notActionable("the violation line is outside the file");
    if (insideComment(result.ast, offset)) return notActionable("inside a comment");
    return classify(deepestStrictNode(result.ast, offset));
  };
}

/** A resolver that refuses every insert, for files with no usable parser. */
export function unavailableSyntax(reason: string): LineSyntaxResolver {
  return () => notActionable(reason);
}

/**
 * A directive's spelling as `open`/`close` strings (re-exported for callers
 * that render a planned insertion without scanning).
 */
export interface CommentEdges {
  open: string;
  close: string;
}

/** The spelling for a resolved insertion context. */
export function edgesFor(context: InsertContext): CommentEdges {
  return context === "jsx-child" ? { open: "{/*", close: " */}" } : { open: "//", close: "" };
}
