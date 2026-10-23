import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ESLint } from "eslint";
import { createLineSyntaxResolver, unavailableSyntax } from "../src/syntax.js";
import type { LineSyntaxResolver } from "../src/syntax.js";

/**
 * Build a classifier from a real ESLint-resolved parser configuration, the same
 * shape `runBatch` passes in production. `overrideConfigFile: true` keeps config
 * search out of the test package.
 */
async function resolverFor(text: string, jsx = true): Promise<LineSyntaxResolver> {
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.jsx"],
        languageOptions: { parserOptions: { ecmaFeatures: { jsx } } },
        rules: {},
      },
    ],
  });
  const config = (await eslint.calculateConfigForFile(join(process.cwd(), "probe.jsx"))) as {
    languageOptions?: Parameters<typeof createLineSyntaxResolver>[1];
  };
  return createLineSyntaxResolver(text, config.languageOptions, "probe.jsx");
}

test("JSX children are jsx-child; opening tags, attributes and JS expressions are js", async () => {
  const text =
    "const App = () => (\n" +
    "  <div>\n" +
    "    <button\n" +
    "      onClick={() => log()}\n" +
    "    >\n" +
    "      hi\n" +
    "    </button>\n" +
    "  </div>\n" +
    ");\n";
  const resolver = await resolverFor(text);

  assert.deepEqual(resolver(1), { context: "js" }, "the expression line above the root JSX");
  assert.deepEqual(resolver(2), { context: "js" }, "the line starting the JSX expression");
  assert.deepEqual(resolver(3), { context: "jsx-child" }, "a child element line");
  assert.deepEqual(resolver(4), { context: "js" }, "an attribute line inside the opening tag");
  assert.deepEqual(resolver(5), { context: "js" }, "the opening tag's closing bracket line");
  assert.deepEqual(resolver(6), { context: "jsx-child" }, "a JSX text child line");
  assert.deepEqual(resolver(7), { context: "jsx-child" }, "a closing child tag line");
});

test("a multi-line JSX expression is js inside its braces, jsx-child at its opening line", async () => {
  const text =
    "<div>\n" +
    "  {items.map((item) =>\n" +
    "    render(item)\n" +
    "  )}\n" +
    "</div>\n";
  const resolver = await resolverFor(text);

  assert.deepEqual(resolver(2), { context: "jsx-child" }, "the `{` line is a child position");
  assert.deepEqual(resolver(3), { context: "js" }, "inside the arrow function body");
  assert.deepEqual(resolver(4), { context: "js" }, "inside the expression container");
  assert.deepEqual(resolver(5), { context: "jsx-child" }, "the closing tag line");
});

test("template literals, multi-line strings and comments are not actionable", async () => {
  const template = "const s = `first\nsecond\nthird`;\n";
  const templateResolver = await resolverFor(template);
  assert.deepEqual(templateResolver(2), { context: "not-actionable", reason: "inside a template literal" });
  assert.deepEqual(templateResolver(3), { context: "not-actionable", reason: "inside a template literal" });

  const comment = "/* first\nsecond\n*/\nconst x = 1;\n";
  const commentResolver = await resolverFor(comment);
  assert.deepEqual(commentResolver(2), { context: "not-actionable", reason: "inside a comment" });

  const jsxString = '<div title="first\nsecond" />\n';
  const jsxStringResolver = await resolverFor(jsxString);
  assert.deepEqual(jsxStringResolver(2), { context: "not-actionable", reason: "inside a string literal" });
});

test("an unparsable file or a missing parser is not actionable, never guessed", async () => {
  const failed = await resolverFor("const = <div>;\n");
  assert.equal(failed(1).context, "not-actionable");
  assert.match((failed(1) as { reason: string }).reason, /could not be parsed/);

  assert.deepEqual(unavailableSyntax("no parser")(1), {
    context: "not-actionable",
    reason: "no parser",
  });

  const noParser = createLineSyntaxResolver("code();\n", undefined, "probe.js");
  assert.deepEqual(noParser(1), {
    context: "not-actionable",
    reason: "no JavaScript parser is configured for this file",
  });
});

test("line 1 of a root JSX expression is js: a directive above it is top-level code", async () => {
  const resolver = await resolverFor("<div>\n  hi\n</div>\n");
  assert.deepEqual(resolver(1), { context: "js" });
  assert.deepEqual(resolver(2), { context: "jsx-child" });
});

test("CRLF line starts classify the same as LF", async () => {
  const text = "<div>\r\n  {value}\r\n</div>\r\n";
  const resolver = await resolverFor(text);
  assert.deepEqual(resolver(2), { context: "jsx-child" });
});

test("a leading shebang does not prevent classification", async () => {
  const resolver = await resolverFor("#!/usr/bin/env node\nconst x = 1;\n");
  assert.deepEqual(resolver(2), { context: "js" });
});

test("a BOM does not shift line classification", async () => {
  const text = "\uFEFF<div>\n  {value}\n</div>\n";
  const resolver = await resolverFor(text);
  assert.deepEqual(resolver(2), { context: "jsx-child" });
});

test("JSX disabled means the file does not parse; the classifier refuses to guess", async () => {
  const resolver = await resolverFor("<div>\n  hi\n</div>\n", false);
  assert.equal(resolver(2).context, "not-actionable");
});
