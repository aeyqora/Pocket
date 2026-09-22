import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectPolicyChange, type PolicyChangeInput } from "../src/policy-change.js";

function detect(overrides: Partial<PolicyChangeInput> = {}) {
  return detectPolicyChange({
    baselineConfig: null,
    headConfig: null,
    baselineRegistry: null,
    headRegistry: null,
    baselineGoverned: [],
    consumedDebt: 0,
    baselineLevels: [],
    headLevels: [],
    ...overrides,
  });
}

const enabled = (value: boolean) => `enabled: ${value}\n`;
const allowlist = (...rules: string[]) =>
  `governedRules:\n${rules.map((r) => `  - ${r}`).join("\n")}\n`;

function record(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    rule: "no-console",
    suppression_type: "next-line",
    fingerprint: "v1:fp",
    file: "app.js",
    type: "permanent",
    reason: "r",
    owner: "o",
    reference: "ref",
    ...overrides,
  };
  return (
    Object.entries(fields)
      .map(([k, v], i) => `${i === 0 ? "- " : "  "}${k}: ${v}`)
      .join("\n") + "\n"
  );
}

describe("policy-change: config weakening", () => {
  it("flags enabled true -> false", () => {
    assert.equal(detect({ baselineConfig: enabled(true), headConfig: enabled(false) }).weakening, true);
  });

  it("flags removal of an explicitly-true enabled key", () => {
    assert.equal(detect({ baselineConfig: enabled(true), headConfig: "# gone\n" }).weakening, true);
  });

  it("does not flag enabled false -> true", () => {
    assert.equal(detect({ baselineConfig: enabled(false), headConfig: enabled(true) }).weakening, false);
  });

  it("flags an allowlist introduced that drops a governed rule", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console", "no-debugger"],
        headConfig: allowlist("no-debugger"),
      }).weakening,
      true,
    );
  });

  it("does not flag an allowlist that covers every governed rule", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console"],
        headConfig: allowlist("no-console"),
      }).weakening,
      false,
    );
  });

  it("flags an allowlist narrowing", () => {
    assert.equal(
      detect({
        baselineConfig: allowlist("no-console", "no-debugger"),
        headConfig: allowlist("no-debugger"),
      }).weakening,
      true,
    );
  });

  it("does not flag an allowlist widening", () => {
    assert.equal(
      detect({
        baselineConfig: allowlist("no-debugger"),
        headConfig: allowlist("no-debugger", "no-console"),
      }).weakening,
      false,
    );
  });

  it("ignores allowlist order and formatting", () => {
    assert.equal(
      detect({
        baselineConfig: allowlist("no-console", "no-debugger"),
        headConfig: "governedRules:\n  - 'no-debugger'\n  - \"no-console\"\n",
      }).weakening,
      false,
    );
  });

  it("does not flag identical documents", () => {
    assert.equal(detect({ baselineConfig: enabled(true), headConfig: enabled(true) }).weakening, false);
  });
});

describe("policy-change: registry broadening", () => {
  it("flags a head that adds a record", () => {
    assert.equal(detect({ headRegistry: record() }).weakening, true);
  });

  it("flags a change to an identity-critical field", () => {
    assert.equal(
      detect({
        baselineRegistry: record({ rule: "no-debugger", fingerprint: "v1:fp2" }),
        headRegistry: record(),
      }).weakening,
      true,
    );
  });

  it("does not flag a non-identity-only change", () => {
    assert.equal(
      detect({
        baselineRegistry: record({ type: "temporary", expires: "2099-01-01" }),
        headRegistry: record({ type: "temporary", expires: "2098-01-01" }),
      }).weakening,
      false,
    );
  });

  it("ignores record order and formatting", () => {
    const a = record();
    const b = record({ rule: "no-debugger", fingerprint: "v1:fp2" });
    assert.equal(detect({ baselineRegistry: a + b, headRegistry: b + a }).weakening, false);
  });

  it("treats a malformed head registry as broadened", () => {
    assert.equal(detect({ headRegistry: "- rule: no-console\n" }).weakening, true);
  });

  it("treats a malformed baseline against a valid head as broadened", () => {
    assert.equal(
      detect({ baselineRegistry: "- rule: no-console\n", headRegistry: record() }).weakening,
      true,
    );
  });

  it("treats identical malformed registries as unchanged", () => {
    assert.equal(
      detect({ baselineRegistry: "- rule: no-console\n", headRegistry: "- rule: no-console\n" })
        .weakening,
      false,
    );
  });
});

describe("policy-change: consumption coupling", () => {
  it("does not fire failure without a weakening delta", () => {
    assert.deepEqual(detect({ consumedDebt: 5 }), {
      weakening: false,
      failure: false,
      source: "none",
    });
  });

  it("records weakening without consumption as a pure policy edit", () => {
    assert.deepEqual(
      detect({ baselineConfig: enabled(true), headConfig: enabled(false), consumedDebt: 0 }),
      { weakening: true, failure: false, source: "protected" },
    );
  });

  it("fails a weakening delta consumed by new debt", () => {
    assert.deepEqual(
      detect({ baselineConfig: enabled(true), headConfig: enabled(false), consumedDebt: 3 }),
      { weakening: true, failure: true, source: "protected" },
    );
  });
});

describe("policy-change: ESLint config severity weakening", () => {
  const lv = (
    rule: string,
    band: number,
    files: string[] | null = null,
    ignores: string[] | null = null,
  ) => ({ rule, files, ignores, band });

  it("flags lowering a governed rule from error to warn", () => {
    assert.deepEqual(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 2)],
        headLevels: [lv("no-console", 1)],
      }),
      { weakening: true, failure: false, source: "eslint-config" },
    );
  });

  it("flags lowering a governed rule from error to off", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 2)],
        headLevels: [lv("no-console", 0)],
      }).weakening,
      true,
    );
  });

  it("flags lowering a governed rule from warn to off", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 1)],
        headLevels: [lv("no-console", 0)],
      }).weakening,
      true,
    );
  });

  it("does not flag raising a governed rule from warn to error", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 1)],
        headLevels: [lv("no-console", 2)],
      }).weakening,
      false,
    );
  });

  it("does not flag unchanged severity", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 1)],
        headLevels: [lv("no-console", 1)],
      }).weakening,
      false,
    );
  });

  it("does not flag a drop for a rule the baseline never governed", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-debugger"],
        baselineLevels: [lv("no-console", 2)],
        headLevels: [lv("no-console", 0)],
      }).weakening,
      false,
    );
  });

  it("does not flag removing a declaration entirely (strengthening)", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 2)],
      }).weakening,
      false,
    );
  });

  it("flags a scoped drop against a global baseline band", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 2)],
        headLevels: [lv("no-console", 2), lv("no-console", 1, ["src/**"])],
      }).weakening,
      true,
    );
  });

  it("flags a scope re-absorbed by a weaker global band", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 0), lv("no-console", 2, ["src/**"])],
        headLevels: [lv("no-console", 0)],
      }).weakening,
      true,
    );
  });

  it("does not flag a drop in a scope the baseline configured stronger elsewhere", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 2, ["src/**"])],
        headLevels: [lv("no-console", 1, ["test/**"])],
      }).weakening,
      false,
    );
  });

  it("does not flag a scoped strengthening", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 1, ["src/**"])],
        headLevels: [lv("no-console", 2, ["src/**"])],
      }).weakening,
      false,
    );
  });

  it("fails a severity drop consumed by new debt", () => {
    assert.deepEqual(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 2)],
        headLevels: [lv("no-console", 1)],
        consumedDebt: 2,
      }),
      { weakening: true, failure: true, source: "eslint-config" },
    );
  });

  it("reports the source as both when protected and eslint surfaces weaken", () => {
    assert.deepEqual(
      detect({
        baselineConfig: enabled(true),
        headConfig: enabled(false),
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 2)],
        headLevels: [lv("no-console", 1)],
      }),
      { weakening: true, failure: false, source: "both" },
    );
  });
});
