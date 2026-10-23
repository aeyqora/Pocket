import { test } from "node:test";
import assert from "node:assert/strict";
import {
  directiveName,
  formatDirective,
  scanDirectives,
  splitRuleList,
} from "../src/scan.js";

test("the scan recognises all four forms with rules, description, indent and code prefix", () => {
  const directives = scanDirectives([
    "/* eslint-disable no-console, no-unused-vars -- legacy */",
    "const x = 1;",
    "  // eslint-disable-next-line no-debugger",
    "  debugger;",
    "code(); // eslint-disable-line no-console",
    "/* eslint-enable no-console */",
    "// eslint-disable no-alert",
  ]);

  assert.equal(directives.length, 5);
  const [block, nextLine, line, enable, fileLevel] = directives;

  assert.deepEqual(
    {
      line: block?.line,
      index: block?.index,
      form: block?.form,
      kind: block?.kind,
      rules: block?.rules,
      description: block?.description,
      bare: block?.bare,
      code: block?.code,
      indent: block?.indent,
      suffix: block?.suffix,
      open: block?.open,
      close: block?.close,
      cr: block?.cr,
      pairLine: block?.pairLine,
    },
    {
      line: 1,
      index: 0,
      form: "block",
      kind: "disable",
      rules: ["no-console", "no-unused-vars"],
      description: "legacy",
      bare: false,
      code: "",
      indent: "",
      suffix: false,
      open: "/*",
      close: " */",
      cr: false,
      pairLine: 6,
    },
    "a whole-line /* */ disable with a matching enable is a block",
  );

  assert.equal(nextLine?.form, "next-line");
  assert.deepEqual(nextLine?.rules, ["no-debugger"]);
  assert.equal(nextLine?.indent, "  ");
  assert.equal(nextLine?.open, "//");
  assert.equal(nextLine?.close, "");
  assert.equal(nextLine?.suffix, false);
  assert.equal(nextLine?.line, 3);

  assert.equal(line?.form, "line");
  assert.equal(line?.suffix, true);
  assert.equal(line?.code, "code();");
  assert.deepEqual(line?.rules, ["no-console"]);
  assert.equal(line?.line, 5);

  assert.equal(enable?.form, "block");
  assert.equal(enable?.kind, "enable");
  assert.deepEqual(enable?.rules, ["no-console"]);
  assert.deepEqual(enable?.closes, [1]);
  assert.equal(enable?.line, 6);

  assert.equal(fileLevel?.form, "file-level");
  assert.equal(fileLevel?.kind, "disable");
  assert.deepEqual(fileLevel?.rules, ["no-alert"]);
  assert.equal(fileLevel?.pairLine, undefined, "a disable with no closer is file-level");
});

test("bare directives are recognised with an empty rule list", () => {
  const directives = scanDirectives([
    "/* eslint-disable-next-line */",
    "// eslint-enable",
    "// eslint-disable",
  ]);
  assert.equal(directives.length, 3);
  assert.equal(directives[0]?.bare, true);
  assert.deepEqual(directives[0]?.rules, []);
  assert.equal(directives[0]?.form, "next-line");
  assert.equal(directives[1]?.kind, "enable");
  assert.equal(directives[1]?.bare, true);
  assert.equal(directives[1]?.closes, undefined, "an orphan enable closes nothing");
  assert.equal(directives[2]?.bare, true);
  assert.deepEqual(directives[2]?.rules, []);
  assert.equal(directives[2]?.form, "file-level");
});

test("the scan carries a directive's trailing description and CRLF flag", () => {
  const [directive] = scanDirectives(["  // eslint-disable-next-line no-console -- why\r"]);
  assert.equal(directive?.description, "why");
  assert.equal(directive?.cr, true);
  assert.equal(directive?.text, "  // eslint-disable-next-line no-console -- why");
  assert.equal(directive?.indent, "  ");
});

test("formatDirective re-renders a directive preserving form, comment, description and CR", () => {
  const [block, nextLine, line] = scanDirectives([
    "/* eslint-disable no-console, no-unused-vars -- legacy */",
    "\t// eslint-disable-next-line no-debugger\r",
    "code(); // eslint-disable-line no-console",
  ]);

  assert.equal(formatDirective(block!, ["no-unused-vars"]), "/* eslint-disable no-unused-vars -- legacy */");
  assert.equal(
    formatDirective(nextLine!, ["no-debugger"]),
    "\t// eslint-disable-next-line no-debugger\r",
    "the comment spelling, indent and CR survive",
  );
  assert.equal(formatDirective(line!, ["no-console"]), "code(); // eslint-disable-line no-console");
  assert.equal(directiveName(block!), "eslint-disable");
  assert.equal(directiveName(nextLine!), "eslint-disable-next-line");
  assert.equal(directiveName(line!), "eslint-disable-line");
});

test("the scan is a µs-per-file operation", () => {
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) {
    if (i % 20 === 0) lines.push(`// eslint-disable-next-line rule-${i} -- note`);
    else if (i % 37 === 0) lines.push(`/* eslint-disable rule-${i} */`);
    else if (i % 41 === 0) lines.push(`doThing(${i}); // eslint-disable-line rule-${i}`);
    else lines.push(`const value${i} = compute(${i});`);
  }

  const RUNS = 300;
  for (let i = 0; i < 20; i++) scanDirectives(lines); // warm up
  const start = process.hrtime.bigint();
  for (let i = 0; i < RUNS; i++) scanDirectives(lines);
  const perRunUs = Number(process.hrtime.bigint() - start) / 1000 / RUNS;

  assert.ok(perRunUs < 500, `a 400-line scan should be µs-scale, took ${perRunUs.toFixed(1)} µs`);
});

test("the scan recognises every comment style, including JSX and suffix block forms", () => {
  const directives = scanDirectives([
    "{/* eslint-disable-next-line no-console */}",
    "{ /* eslint-disable-next-line no-debugger -- spaced */ }",
    "<div>{value}</div>{/* eslint-disable-line no-alert */}",
    "code(); /* eslint-disable-line no-unused-vars */",
    "above(); /* eslint-disable-next-line no-console */",
    "{/* eslint-disable no-console */}",
    "{/* eslint-enable no-console */}",
  ]);

  assert.deepEqual(
    directives.map((directive) => ({
      line: directive.line,
      form: directive.form,
      kind: directive.kind,
      rules: directive.rules,
      description: directive.description,
      suffix: directive.suffix,
      indent: directive.indent,
      code: directive.code,
      open: directive.open,
      close: directive.close,
    })),
    [
      { line: 1, form: "next-line", kind: "disable", rules: ["no-console"], description: "", suffix: false, indent: "", code: "", open: "{/*", close: " */}" },
      { line: 2, form: "next-line", kind: "disable", rules: ["no-debugger"], description: "spaced", suffix: false, indent: "", code: "", open: "{ /*", close: " */ }" },
      { line: 3, form: "line", kind: "disable", rules: ["no-alert"], description: "", suffix: true, indent: "", code: "<div>{value}</div>", open: "{/*", close: " */}" },
      { line: 4, form: "line", kind: "disable", rules: ["no-unused-vars"], description: "", suffix: true, indent: "", code: "code();", open: "/*", close: " */" },
      { line: 5, form: "next-line", kind: "disable", rules: ["no-console"], description: "", suffix: true, indent: "", code: "above();", open: "/*", close: " */" },
      { line: 6, form: "block", kind: "disable", rules: ["no-console"], description: "", suffix: false, indent: "", code: "", open: "{/*", close: " */}" },
      { line: 7, form: "block", kind: "enable", rules: ["no-console"], description: "", suffix: false, indent: "", code: "", open: "{/*", close: " */}" },
    ],
  );
  assert.deepEqual(directives[5]?.pairLine, 7);
  assert.deepEqual(directives[6]?.closes, [6]);
});

test("formatDirective preserves JSX and spaced spellings exactly", () => {
  const [jsx, spaced] = scanDirectives([
    "{/* eslint-disable-next-line no-console */}",
    "{ /* eslint-disable no-alert */ }",
  ]);
  assert.equal(formatDirective(jsx!, ["no-console"]), "{/* eslint-disable-next-line no-console */}");
  assert.equal(formatDirective(spaced!, ["no-alert"]), "{ /* eslint-disable no-alert */ }");
});

test("CRLF and a trailing description survive every comment style", () => {
  const directives = scanDirectives([
    "  {/* eslint-disable-next-line no-console -- why */}\r",
    "  { /* eslint-disable no-alert -- legacy */ }\r",
  ]);
  assert.equal(directives[0]?.cr, true);
  assert.equal(directives[0]?.description, "why");
  assert.equal(
    formatDirective(directives[0]!, ["no-console"]),
    "  {/* eslint-disable-next-line no-console -- why */}\r",
  );
  assert.equal(
    formatDirective(directives[1]!, ["no-alert"]),
    "  { /* eslint-disable no-alert -- legacy */ }\r",
  );
});

test("splitRuleList separates rules from a trailing -- description", () => {
  assert.deepEqual(splitRuleList("no-console, no-unused-vars -- because it logs"), {
    rules: ["no-console", "no-unused-vars"],
    desc: "because it logs",
    bare: false,
  });
  assert.deepEqual(splitRuleList(""), { rules: [], desc: "", bare: true });
});
