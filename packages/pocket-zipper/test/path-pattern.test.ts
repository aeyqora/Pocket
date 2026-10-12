import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foreignSyntax, globToRegExp, patternMatches } from "../src/path-pattern.js";

/**
 * The pattern dialect's own unit table: the CODEOWNERS subset the policy's
 * path keys speak, exercised as a pure function. This is the one new seam the
 * governed-path effort introduces — everything else rides the existing seams.
 */
describe("path-pattern dialect", () => {
  it("a trailing `/` claims the directory and everything under it", () => {
    assert.equal(patternMatches("packages/", "packages"), true);
    assert.equal(patternMatches("packages/", "packages/legacy.js"), true);
    assert.equal(patternMatches("packages/", "packages/deep/nested/file.js"), true);
    assert.equal(patternMatches("packages/", "other"), false);
    assert.equal(patternMatches("packages/", "packagesx"), false);
  });

  it("a slashless pattern matches that basename at any depth", () => {
    assert.equal(patternMatches("package.json", "package.json"), true);
    assert.equal(patternMatches("package.json", "src/package.json"), true);
    assert.equal(patternMatches("package.json", "a/b/c/package.json"), true);
    assert.equal(patternMatches("package.json", "src/package.json.bak"), false);
    assert.equal(patternMatches("package.json", "packagejson"), false);
  });

  it("any slash anchors to the repository root", () => {
    assert.equal(patternMatches("src/util.js", "src/util.js"), true);
    assert.equal(patternMatches("src/util.js", "lib/src/util.js"), false);
    // A leading `/` is optional and changes nothing.
    assert.equal(patternMatches("/src/util.js", "src/util.js"), true);
  });

  it("a single `*` stays within a segment", () => {
    assert.equal(patternMatches("src/*", "src/a.js"), true);
    assert.equal(patternMatches("src/*", "src/a/b.js"), false);
    assert.equal(patternMatches("src/*.js", "src/a.js"), true);
    assert.equal(patternMatches("src/*.js", "src/a.ts"), false);
  });

  it("`**` crosses a segment", () => {
    assert.equal(patternMatches("src/**", "src/a.js"), true);
    assert.equal(patternMatches("src/**", "src/a/b.js"), true);
    assert.equal(patternMatches("src/**", "src/a/b/c/d.js"), true);
    assert.equal(patternMatches("src/**", "other/a.js"), false);
  });

  it("`**` alone matches everything", () => {
    assert.equal(patternMatches("**", "a"), true);
    assert.equal(patternMatches("**", "a/b/c/d.js"), true);
  });

  it("matching is case-sensitive", () => {
    assert.equal(patternMatches("src/*", "src/A.js"), true);
    assert.equal(patternMatches("SRC/*", "src/a.js"), false);
    assert.equal(patternMatches("SRC/*", "SRC/a.js"), true);
  });

  it("`**/` spans zero or more directory levels, including none", () => {
    assert.equal(patternMatches("**/*.spec.ts", "a.spec.ts"), true);
    assert.equal(patternMatches("**/*.spec.ts", "src/a.spec.ts"), true);
    assert.equal(patternMatches("**/*.spec.ts", "src/deep/a.spec.ts"), true);
  });

  it("escapes regex metacharacters as literals", () => {
    // A `.` is a literal dot, not "any character".
    assert.equal(patternMatches("src/a.js", "src/aXjs"), false);
    assert.equal(patternMatches("src/a.js", "src/a.js"), true);
  });
});

describe("path-pattern foreign syntax", () => {
  it("flags negation", () => {
    assert.equal(foreignSyntax("!src/"), "negation ('!')");
  });

  it("flags brace alternation", () => {
    assert.equal(foreignSyntax("*.{js,ts}"), "brace alternation ('{a,b}')");
    assert.equal(foreignSyntax("src/{a,b}.js"), "brace alternation ('{a,b}')");
  });

  it("flags character classes", () => {
    assert.equal(foreignSyntax("[abc].js"), "character class ('[abc]')");
    assert.equal(foreignSyntax("src/[a-z].js"), "character class ('[abc]')");
  });

  it("accepts the documented subset", () => {
    for (const ok of ["src/", "src/*", "src/**", "**", "*.js", "**/*.spec.ts", "package.json"]) {
      assert.equal(foreignSyntax(ok), null, ok);
    }
  });
});

describe("globToRegExp", () => {
  it("renders `**/` as a cross-segment span", () => {
    assert.equal(globToRegExp("**/"), "(?:.*/)?");
  });

  it("renders a lone `*` as a segment-local span", () => {
    assert.equal(globToRegExp("*"), "[^/]*");
  });

  it("renders a trailing `**` as match-anything", () => {
    assert.equal(globToRegExp("**"), ".*");
  });
});
