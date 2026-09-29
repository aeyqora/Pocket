import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalConfigOffText,
  canonicalDirectiveText,
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
