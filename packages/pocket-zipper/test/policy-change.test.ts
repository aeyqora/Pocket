import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectPolicyChange, severityFloorViolations } from "../src/policy-change.js";
import type { PolicyChangeInput, PolicyChangeResult } from "../src/policy-change.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { loadRegistry } from "../src/validate.js";

/**
 * The detector's contract, with the registries written the way a *fixture*
 * writes them — as documents — and parsed here by the failing read every
 * evaluation path uses. The seam under test takes records (D4), so a defective
 * registry cannot be expressed as a "not broadening" case at all: it throws
 * before the detector is reached, which is the property the type buys.
 */
function detect(
  overrides: Partial<Omit<PolicyChangeInput, "baselineRegistry" | "headRegistry">> & {
    baselineRegistry?: string | null;
    headRegistry?: string | null;
  } = {},
): PolicyChangeResult {
  const { baselineRegistry = null, headRegistry = null, ...rest } = overrides;
  return detectPolicyChange({
    baselineConfig: null,
    headConfig: null,
    baselineRegistry: baselineRegistry === null ? null : loadRegistry(baselineRegistry),
    headRegistry: headRegistry === null ? null : loadRegistry(headRegistry),
    baselineGoverned: [],
    consumedDebt: 0,
    // No opt-in unless a case declares one: the same-change exception is the
    // only thing these literals' new `combined` field can turn on, and a default
    // that opted in would make it a test of the default rather than of the shape.
    baselinePolicy: { ...DEFAULT_POLICY },
    baselineLevels: [],
    headLevels: [],
    // Every case below is a "the protected document changed" case unless it says
    // otherwise in its name.
    protectedTouched: true,
    ...rest,
  });
}

const enabled = (value: boolean) => `enabled: ${value}\n`;
const allowlist = (...rules: string[]) =>
  `governedRules:\n${rules.map((r) => `  - ${r}`).join("\n")}\n`;

/** Three well-formed fingerprints: broadening compares match keys, not validity. */
const FP_A = `v1:sha256:${"a".repeat(64)}`;
const FP_B = `v1:sha256:${"b".repeat(64)}`;
const FP_C = `v1:sha256:${"c".repeat(64)}`;

function record(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    rule: "no-console",
    suppression_type: "next-line",
    fingerprint: FP_A,
    file: "app.js",
    type: "permanent",
    reason: "r",
    reference: "ref",
    ...overrides,
  };
  return (
    Object.entries(fields)
      .map(([k, v], i) => `${i === 0 ? "- " : "  "}${k}: ${v}`)
      .join("\n") + "\n"
  );
}

const lv = (
  rule: string,
  band: number,
  files: string[] | null = null,
  ignores: string[] | null = null,
) => ({ rule, files, ignores, band });

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
        baselineRegistry: record({ rule: "no-debugger", fingerprint: FP_B }),
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
    const b = record({ rule: "no-debugger", fingerprint: FP_B });
    // Reordering is the stronger half of "no delta": the same records, written
    // in the other order, and the result names no change of either shape.
    assert.deepEqual(detect({ baselineRegistry: a + b, headRegistry: b + a }), {
      weakening: false,
      failure: false,
      source: "none",
      registry: "none",
      shape: "none",
      sanctioned: [],
      combined: false,
    });
  });
});

/**
 * The delta's two shapes. `registry` answers "how did the registry itself
 * change"; `shape` answers "how did the whole delta change", which is the value
 * ticket 07's combined-mode waiver reads.
 */
describe("policy-change: the registry delta's shape", () => {
  it("reads a new match key as an additive grant", () => {
    // The new key sits beside a record the head still carries, in the same file:
    // nothing was re-pointed, so nothing was edited.
    const kept = record({ rule: "no-debugger", fingerprint: FP_B });
    assert.equal(
      detect({ baselineRegistry: kept, headRegistry: kept + record() }).registry,
      "additive",
    );
  });

  it("reads a same-file repoint as an edit", () => {
    // One record for another in the same file: the diff cannot tell this from a
    // removal and an addition, and it must not read as a fresh grant.
    assert.equal(
      detect({
        baselineRegistry: record({ rule: "no-debugger", fingerprint: FP_B }),
        headRegistry: record(),
      }).registry,
      "edit",
    );
  });

  it("reads a twin append as no delta", () => {
    // The appended record shares the match key and differs only in the line a
    // reader is helped by. The authorized set of match keys did not grow.
    assert.equal(
      detect({ baselineRegistry: record(), headRegistry: record() + record({ line: "7" }) })
        .registry,
      "none",
    );
  });

  it("prefers edit over additive when one delta carries both", () => {
    const base = record() + record({ rule: "no-debugger", fingerprint: FP_B, file: "lib.js" });
    // app.js gains a key beside its intact record: additive on its own.
    const additive = record() + record({ suppression_type: "block" });
    assert.equal(detect({ baselineRegistry: base, headRegistry: additive }).registry, "additive");
    // The same change, plus lib.js re-pointing its own record. One more file,
    // and the verdict flips — which is what keeps the waiver downstream from
    // reading a combined PR as a fresh grant.
    const both = additive + record({ rule: "no-debugger", fingerprint: FP_C, file: "lib.js" });
    assert.equal(detect({ baselineRegistry: base, headRegistry: both }).registry, "edit");
  });
});

describe("policy-change: shape against the surfaces that contributed", () => {
  it("calls a sole registry grant additive", () => {
    const result = detect({ headRegistry: record() });
    assert.equal(result.registry, "additive");
    assert.equal(result.shape, "additive");
    assert.equal(result.source, "protected");
  });

  it("calls a registry grant beside an enabled flip an edit", () => {
    const result = detect({
      headRegistry: record(),
      baselineConfig: enabled(true),
      headConfig: enabled(false),
    });
    assert.equal(result.registry, "additive");
    assert.equal(result.shape, "edit");
    assert.equal(result.source, "protected");
  });

  it("calls a registry grant beside a severity drop an edit", () => {
    const result = detect({
      headRegistry: record(),
      baselineGoverned: ["no-console"],
      baselineLevels: [lv("no-console", 2)],
      headLevels: [lv("no-console", 1)],
    });
    assert.equal(result.registry, "additive");
    assert.equal(result.shape, "edit");
    assert.equal(result.source, "both");
  });
});

describe("policy-change: the protected-file trigger", () => {
  it("reports nothing when the change touched no protected file", () => {
    // A re-point that would otherwise read as an edit, judged with the flag off:
    // a protected file the change does not touch is not part of the change.
    const result = detect({
      protectedTouched: false,
      baselineRegistry: record({ rule: "no-debugger", fingerprint: FP_B }),
      headRegistry: record(),
    });
    assert.equal(result.weakening, false);
    assert.equal(result.shape, "none");
    assert.equal(result.source, "none");
  });

  it("still reports a severity drop when the change touched no protected file", () => {
    // The flag gates the two `.pocket-zipper` surfaces, not the ESLint flat
    // config's own severities: a governed rule turned `off` or `warn` is the
    // same policy change however the change is spelled, and four CLI tests pin
    // that it fires without `eslint.config.*` being under `.pocket-zipper/**`.
    const result = detect({
      protectedTouched: false,
      baselineGoverned: ["no-console"],
      baselineLevels: [lv("no-console", 2)],
      headLevels: [lv("no-console", 1)],
    });
    assert.equal(result.weakening, true);
    assert.equal(result.source, "eslint-config");
  });
});

describe("policy-change: consumption coupling", () => {
  it("does not fire failure without a weakening delta", () => {
    assert.deepEqual(detect({ consumedDebt: 5 }), {
      weakening: false,
      failure: false,
      source: "none",
      registry: "none",
      shape: "none",
      sanctioned: [],
      combined: false,
    });
  });

  it("records weakening without consumption as a pure policy edit", () => {
    assert.deepEqual(
      detect({ baselineConfig: enabled(true), headConfig: enabled(false), consumedDebt: 0 }),
      { weakening: true, failure: false, source: "protected", registry: "none", shape: "edit", sanctioned: [], combined: false },
    );
  });

  it("fails a weakening delta consumed by new debt", () => {
    assert.deepEqual(
      detect({ baselineConfig: enabled(true), headConfig: enabled(false), consumedDebt: 3 }),
      { weakening: true, failure: true, source: "protected", registry: "none", shape: "edit", sanctioned: [], combined: false },
    );
  });

  it("fails a consumed additive grant", () => {
    // Both shapes gate identically in this ticket: the split changes the
    // message, never the verdict. The waiver of the additive case is what
    // ticket 06 defers, and this is the assertion that says so.
    const result = detect({ headRegistry: record(), consumedDebt: 1 });
    assert.equal(result.registry, "additive");
    assert.equal(result.failure, true);
  });

  it("fails a consumed identity edit", () => {
    const result = detect({
      baselineRegistry: record({ rule: "no-debugger", fingerprint: FP_B }),
      headRegistry: record(),
      consumedDebt: 1,
    });
    assert.equal(result.registry, "edit");
    assert.equal(result.failure, true);
  });
});

describe("policy-change: ESLint config severity weakening", () => {
  it("flags lowering a governed rule from error to warn", () => {
    assert.deepEqual(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 2)],
        headLevels: [lv("no-console", 1)],
      }),
      { weakening: true, failure: false, source: "eslint-config", registry: "none", shape: "edit", sanctioned: [], combined: false },
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

  it("uses baseline config declarations for scoped severity governance", () => {
    assert.equal(
      detect({
        baselineGoverned: [],
        baselineSeverityGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 2)],
        headLevels: [lv("no-console", 0)],
      }).weakening,
      true,
    );
  });

  it("does not flag removing a declaration entirely (strengthening)", () => {
    assert.equal(
      detect({
        baselineGoverned: ["no-console"],
        baselineLevels: [lv("no-console", 1)],
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
      { weakening: true, failure: true, source: "eslint-config", registry: "none", shape: "edit", sanctioned: [], combined: false },
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
      { weakening: true, failure: false, source: "both", registry: "none", shape: "edit", sanctioned: [], combined: false },
    );
  });
});

describe("policy-change: severity floors", () => {
  const levels = (band: number, files: string[] | null = null) => [lv("no-console", band, files)];

  it("fails a floored error rule stepped down to warn or off", () => {
    assert.deepEqual(
      severityFloorViolations({
        minSeverities: { "no-console": "error" },
        baselineLevels: levels(2),
        headLevels: levels(1),
      }),
      [{ rule: "no-console", floor: "error", head: "warn", baseline: "error" }],
    );
    assert.equal(
      severityFloorViolations({
        minSeverities: { "no-console": "error" },
        baselineLevels: levels(2),
        headLevels: levels(0),
      })[0]?.head,
      "off",
    );
  });

  it("permits a warn floor's migration step but fails its next drop", () => {
    assert.deepEqual(
      severityFloorViolations({
        minSeverities: { "no-console": "warn" },
        baselineLevels: levels(2),
        headLevels: levels(1),
      }),
      [],
    );
    assert.deepEqual(
      severityFloorViolations({
        minSeverities: { "no-console": "warn" },
        baselineLevels: levels(1),
        headLevels: levels(0),
      }),
      [{ rule: "no-console", floor: "warn", head: "off", baseline: "warn" }],
    );
  });

  it("grandfathers a band already below its floor, but not a further drop", () => {
    assert.deepEqual(
      severityFloorViolations({
        minSeverities: { "no-console": "error" },
        baselineLevels: levels(1),
        headLevels: levels(1),
      }),
      [],
    );
    assert.deepEqual(
      severityFloorViolations({
        minSeverities: { "no-console": "error" },
        baselineLevels: levels(1),
        headLevels: levels(0),
      }),
      [{ rule: "no-console", floor: "error", head: "off", baseline: "warn" }],
    );
  });

  it("fails when the baseline has no declaration for a floored head rule", () => {
    assert.deepEqual(
      severityFloorViolations({
        minSeverities: { "no-console": "warn" },
        baselineLevels: [],
        headLevels: levels(0),
      }),
      [{ rule: "no-console", floor: "warn", head: "off", baseline: "undeclared" }],
    );
  });
});
