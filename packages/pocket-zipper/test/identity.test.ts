import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalCodeLine,
  canonicalConfigOffText,
  canonicalDirectiveText,
  canonicalMovementLine,
  fingerprintOf,
  parseDirectiveArgs,
  scopeKeyOf,
} from "../src/identity.js";

describe("identity: canonical directive text", () => {
  it("sorts, trims, and dedupes rule tokens", () => {
    assert.equal(
      canonicalDirectiveText("next-line", [" no-debugger ", "no-console", "no-console"]),
      "next-line\nno-console,no-debugger",
    );
  });

  it("separates forms with the same rule set", () => {
    assert.notEqual(
      canonicalDirectiveText("next-line", ["no-console"]),
      canonicalDirectiveText("line", ["no-console"]),
    );
  });

  it("derives stable fingerprints from canonical text", () => {
    const a = fingerprintOf(canonicalDirectiveText("block", ["no-console"]));
    const b = fingerprintOf(canonicalDirectiveText("next-line", ["no-console"]));
    assert.match(b, /^v1:sha256:[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });
});

describe("identity: parseDirectiveArgs", () => {
  it("splits normalized rules from the free-text justification", () => {
    assert.deepEqual(parseDirectiveArgs(" no-console, no-debugger -- why we allow "), {
      rules: ["no-console", "no-debugger"],
      justification: "why we allow",
    });
  });

  it("returns no rules for an unnamed directive", () => {
    assert.deepEqual(parseDirectiveArgs("   "), { rules: [], justification: "" });
  });
});

describe("identity: canonicalCodeLine", () => {
  it("collapses whitespace but leaves non-directive code intact", () => {
    assert.equal(canonicalCodeLine("  foo   --   bar  "), "foo -- bar");
  });

  it("strips a directive's justification", () => {
    assert.equal(
      canonicalCodeLine("// eslint-disable-next-line no-console -- reason"),
      "// eslint-disable-next-line no-console",
    );
  });
});

describe("identity: canonicalMovementLine", () => {
  it("strips inline code from a line-form directive", () => {
    assert.equal(
      canonicalMovementLine("console.log(1); // eslint-disable-line no-console"),
      "eslint-disable-line no-console",
    );
  });

  it("normalizes rule order and whitespace", () => {
    assert.equal(
      canonicalMovementLine("// eslint-disable-next-line no-debugger,  no-console"),
      "eslint-disable-next-line no-console,no-debugger",
    );
  });

  it("dedupes repeated rule tokens", () => {
    assert.equal(
      canonicalMovementLine("// eslint-disable-next-line no-console, no-console"),
      "eslint-disable-next-line no-console",
    );
  });

  it("handles the block-comment line form", () => {
    assert.equal(
      canonicalMovementLine("/* eslint-disable-line no-console */"),
      "eslint-disable-line no-console",
    );
  });

  it("drops a directive's justification", () => {
    assert.equal(
      canonicalMovementLine("// eslint-disable-next-line no-console -- reason"),
      "eslint-disable-next-line no-console",
    );
  });

  it("leaves region directives and plain code on the code-line path", () => {
    assert.equal(
      canonicalMovementLine("/* eslint-disable no-console */"),
      "/* eslint-disable no-console */",
    );
    assert.equal(canonicalMovementLine("  a();  "), "a();");
  });
});

describe("identity: config-off identity", () => {
  it("is stable under pattern order and whitespace", () => {
    assert.equal(
      scopeKeyOf("eslint.config.js", [" z ", "a"], ["dist"]),
      scopeKeyOf("eslint.config.js", ["a", "z"], ["dist"]),
    );
  });

  it("changes with the config file or the scope", () => {
    assert.notEqual(
      scopeKeyOf("eslint.config.js", ["a"], null),
      scopeKeyOf("eslint.config.mjs", ["a"], null),
    );
    assert.notEqual(
      scopeKeyOf("eslint.config.js", ["a"], null),
      scopeKeyOf("eslint.config.js", null, null),
    );
  });

  it("feeds a distinct fingerprint per rule and scope", () => {
    const scope = scopeKeyOf("eslint.config.js", ["a"], null);
    assert.notEqual(
      fingerprintOf(canonicalConfigOffText("no-console", scope)),
      fingerprintOf(canonicalConfigOffText("no-debugger", scope)),
    );
  });
});
