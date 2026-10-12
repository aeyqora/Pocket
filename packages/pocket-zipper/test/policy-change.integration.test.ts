import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  configYaml,
  eslintConfig,
  exceptionYaml,
  hasErrorCode,
  NEXT_LINE_NO_CONSOLE_FP,
  NEXT_LINE_NO_DEBUGGER_FP,
  repo,
  cleanupRepos,
  PROTECTED_REGISTRY,
  PROTECTED_CONFIG,
  scopedEslintConfig,
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";
import { addDuration } from "../src/policy.js";

after(cleanupRepos);

const disabled = "// eslint-disable-next-line no-console\n";
const noDebugger = "// eslint-disable-next-line no-debugger\n";

/**
 * The two `POLICY_CHANGE` sentences, each split at the point the delta's shape
 * is named: the first half is the existing wording and must not move, the
 * second is the clause under test, pinned byte for byte.
 */
const CONSUMED = "policy weakening consumed by new suppression debt in the same change";
const ROUTED = "policy weakening detected (routed through protected-branch review)";
const ADDITIVE_CLAUSE = ": a new exception record authorizes debt the baseline registry did not";
const EDIT_CLAUSE =
  ": an existing exception record's identity changed, so it now authorizes different debt";

/** Inside the 3mo default maximum: the date a passing pure policy PR writes. */
const WITHIN_HORIZON = addDuration(new Date().toISOString().slice(0, 10), "1mo");
/** Past it: the date a change that is refused for its expiry writes. */
const BEYOND_HORIZON = addDuration(new Date().toISOString().slice(0, 10), "6mo");

/**
 * A registry the loader rejects: a record carrying two of its nine fields.
 * Nothing here is about policy — the point is that a file this tool cannot
 * read is a defect, and a defect is not a policy edit.
 */
const MALFORMED_REGISTRY = "- rule: no-console\n  type: temporary\n";

function policyChangeMessage(
  record: { errors: Array<{ code: string; message: string }> } | null,
): string {
  const entry = record?.errors.find((e) => e.code === "POLICY_CHANGE");
  assert.ok(entry, "expected a POLICY_CHANGE entry");
  return entry.message;
}

function codes(record: { errors: Array<{ code: string }> } | null): string[] {
  return record?.errors.map((e) => e.code) ?? [];
}

describe("policy-change detection through the pipeline", () => {
  it("fails when a weakening edit is consumed by new debt in the same change", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_CONFIG, configYaml({ enabled: false }));
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });

  it("fails when removal of an explicitly-true enabled key is consumed", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_CONFIG, "# policy unchanged beyond removing the flag\n");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });

  it("does not fire when no protected file is touched", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), false);
  });

  it("fires even when the consumed debt is authorized by an exception", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_CONFIG, configYaml({ enabled: false }));
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.summary.newDebt.authorized, 1);
  });

  it("fails a membership loss consumed even when the debt is authorized", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(
      PROTECTED_CONFIG,
      configYaml({ governedRules: ["no-console", "no-debugger"] }),
    );
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-debugger",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_CONFIG, configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", `export const a = 1;\n${noDebugger}\ndebugger;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });

  it("fails an absent-to-narrower allowlist consumed even when the debt is authorized", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-debugger",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_CONFIG, configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", `export const a = 1;\n${noDebugger}\ndebugger;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });

  it("fires when the exception registry broadens and is consumed", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });

  it("does not fire when an appended record is a twin of one the registry already has", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        type: "permanent",
        line: 2,
      }),
    );
    r.commit("base");
    r.branch("base");
    // The appended record is a twin: the same match key, distinct only in the
    // line a reader is helped by — which is not a match input. The authorized
    // *set* of match keys has not grown, so this is a second record for debt the
    // registry already permitted, not a widening of what it permits. Had
    // broadening compared records rather than keys, this would read as a
    // weakening and the same change would fail.
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        type: "permanent",
        line: 2,
      }) +
        exceptionYaml({
          rule: "no-console",
          suppressionType: "next-line",
          fingerprint: NEXT_LINE_NO_CONSOLE_FP,
          file: "app.js",
          type: "permanent",
          line: 3,
        }),
    );
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), false);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
  });

  it("fires when a record's identity-critical field changes and is consumed", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-debugger",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });
});

describe("a registry the change made unreadable", () => {
  it("refuses a pure policy change that lands a malformed registry", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    // No code change, no debt, no directive — the change is the registry, and
    // the registry is malformed. Today this lands with `errors: []` and exit
    // 0: the one shape in which a broken registry merges.
    r.write(PROTECTED_REGISTRY, MALFORMED_REGISTRY);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
    // The loader's own diagnostic line, not a restatement in the tool's words.
    assert.match(
      res.record?.errors[0]?.message ?? "",
      /^\.pocket-zipper\/exceptions\.yml:\d+:\d+\s+MISSING_FIELD\s+entry 1 · suppression_type\s+'suppression_type' is required/,
    );
  });

  it("reports the defect alone, never beside a policy change", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    // The same malformed registry, beside debt the change introduced. A file
    // that cannot be read has no delta to judge, so this change has nothing to
    // report about policy at all — one tier of error, not two.
    r.write(PROTECTED_REGISTRY, MALFORMED_REGISTRY);
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.ok(codes(res.record).length > 0);
    assert.deepEqual([...new Set(codes(res.record))], ["CONFIG_ERROR"]);
  });
});

describe("the shape the registry weakening is reported as", () => {
  it("names a new grant consumed by new debt an additive weakening", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(
      policyChangeMessage(res.record),
      `${CONSUMED}${ADDITIVE_CLAUSE}`,
    );
  });

  it("names a re-pointed record consumed by new debt an identity edit", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
        file: "app.js",
        type: "permanent",
      }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    // The one record, the one slot, a different fingerprint: the same slot
    // re-pointed at different debt, which authorizes something the baseline
    // record did not.
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        type: "permanent",
      }),
    );
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(
      policyChangeMessage(res.record),
      `${CONSUMED}${EDIT_CLAUSE}`,
    );
  });

  it("reads a removal and an addition in the same file as an edit, not a new grant", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-debugger",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    // The diff cannot tell this from a re-point: one record for `no-debugger`
    // is gone and one for `no-console` has taken its place, in the same file.
    // A reader comparing the two sets sees a key the baseline never had, and
    // the honest name for that is an edit.
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: "2099-01-01",
      }),
    );
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(
      policyChangeMessage(res.record),
      `${CONSUMED}${EDIT_CLAUSE}`,
    );
  });

  it("records a new grant with nothing to consume as an additive policy change that passes", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    // A pure policy PR: a well-formed record the baseline registry did not
    // carry, and no debt beside it. It is recorded rather than refused, and the
    // shape is named on this side of the gate too. The date is inside the
    // maximum, so the expiry policy has nothing to say about it.
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: WITHIN_HORIZON,
      }),
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.verdict, "pass");
    assert.equal(
      policyChangeMessage(res.record),
      `${ROUTED}${ADDITIVE_CLAUSE}`,
    );
    assert.equal(codes(res.record).includes("EXPIRY_POLICY"), false);
  });

  it("reports a new grant and a beyond-max date as one policy change and one expiry refusal", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      PROTECTED_REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: BEYOND_HORIZON,
      }),
    );
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    // Two distinct rules, refused for distinct reasons. "No double-failure
    // noise" is the count: one line each, not one line and its restatement.
    assert.deepEqual(codes(res.record).sort(), ["EXPIRY_POLICY", "POLICY_CHANGE"]);
    assert.equal(
      policyChangeMessage(res.record),
      `${CONSUMED}${ADDITIVE_CLAUSE}`,
    );
  });
});

describe("config-level severity weakenings as policy changes", () => {
  it("records a scoped config-only error-to-off weakening and passes", () => {
    const r = repo();
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "off" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base", "--verbose"]);
    assert.equal(res.status, 0);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.match(res.stdout, /error\[POLICY_CHANGE\]/);
  });

  it("records a scoped config-only error-to-warn weakening and passes", () => {
    const r = repo();
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "warn" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });

  it("keeps scoped weakening plus new directive debt failing", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      scopedEslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      "eslint.config.mjs",
      scopedEslintConfig({ "no-console": "off", "no-debugger": "error" }),
    );
    r.write("app.js", `${noDebugger}debugger;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.verdict, "fail");
  });

  it("records scoped config-only weakening in pre-commit mode", () => {
    const r = repo();
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "off" }));
    r.stage("eslint.config.mjs");
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 0);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });

  it("keeps scoped weakening plus new directive debt failing in pre-commit mode", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      scopedEslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.write(
      "eslint.config.mjs",
      scopedEslintConfig({ "no-console": "off", "no-debugger": "error" }),
    );
    r.write("app.js", `${noDebugger}debugger;\n`);
    r.stage();
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.verdict, "fail");
  });

  it("keeps the allowlist as a narrowing boundary for scoped severity weakening", () => {
    const r = repo();
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "off" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), false);
  });

  it("reports both the scoped policy change and severity floor", () => {
    const r = repo();
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ minSeverities: { "no-console": "error" } }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "warn" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.deepEqual(codes(res.record), ["POLICY_CHANGE", "SEVERITY_FLOOR"]);
  });

  it("does not reconcile unrelated baseline suppressions for a config-only change", () => {
    const r = repo();
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "error" }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", scopedEslintConfig({ "no-console": "warn" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.dispositions.existing, 0);
    assert.equal(res.record?.summary.dispositions.removed, 0);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });

  it("records a pure config-level off addition as a policy change that passes", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    assert.match(res.stdout, /PASS/);
    assert.match(res.stdout, /POLICY_CHANGE/);
  });

  it("fails when a config-level off weakening is consumed by new directive debt", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off", "no-debugger": "error" }));
    r.write("app.js", `${noDebugger}\ndebugger;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.verdict, "fail");
  });

  it("does not fire a policy change for an off of a rule the allowlist never governed", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(PROTECTED_CONFIG, configYaml({ governedRules: ["no-debugger"] }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off", "no-debugger": "error" }));
    r.write("app.js", "export const a = 2;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), false);
  });

  it("records an off that hides a same-change directive as a policy change, not debt", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "off" }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
  });

  it("records lowering a governed rule from error to warn as a policy change that passes", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "warn" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    assert.match(res.stdout, /POLICY_CHANGE/);
  });

  it("fails a config step-down covered by a severity floor", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ minSeverities: { "no-console": "error" } }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "warn" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.schemaVersion, 4);
    assert.deepEqual(res.record?.summary.policy.minSeverities, { "no-console": "error" });
    assert.ok(hasErrorCode(res.record, "SEVERITY_FLOOR"));
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    const error = res.record?.errors.find((entry) => entry.code === "SEVERITY_FLOOR");
    assert.deepEqual(error?.detail, {
      rule: "no-console",
      floor: "error",
      head: "warn",
      baseline: "error",
    });
    assert.match(res.stdout, /no-console.*error.*warn/);
  });

  it("does not fire for a warn-to-error strengthening", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "warn" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), false);
  });

  it("fails the same floor in pre-commit and explains baseline authority", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ minSeverities: { "no-console": "error" } }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "warn" }));
    r.stage("eslint.config.mjs");
    const res = r.runCli(["pre-commit"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.mode, "pre-commit");
    assert.ok(hasErrorCode(res.record, "SEVERITY_FLOOR"));
    assert.match(res.stdout, /staged policy floor is 'error'/);
    assert.match(res.stdout, /takes effect from the next commit/);
  });

  it("lands a deliberate step-down as two commits: the floor first, then the band", () => {
    // The shape the config reference tells readers to use, and the only
    // authorization a step-down has. Commit 1 raises no gate term of its own —
    // it is reviewed because it lands on the protected path — and commit 2 is
    // judged under it. One change carrying both fails, because the evaluation
    // reads the baseline's floor.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ minSeverities: { "no-console": "error" } }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");

    r.write(PROTECTED_CONFIG, configYaml({ minSeverities: { "no-console": "warn" } }));
    r.commit("lower the floor");
    const lowered = r.runCli(["check", "--base", "base"]);
    assert.equal(lowered.status, 0);
    assert.deepEqual(codes(lowered.record), []);

    r.branch("floor-merged");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "warn" }));
    r.commit("step the band down");
    const landed = r.runCli(["check", "--base", "floor-merged"]);
    assert.equal(landed.status, 0);
    // The floor removes the failure, not the record: the weakening is still
    // reported, which is what keeps the two facts distinguishable.
    assert.deepEqual(codes(landed.record), ["POLICY_CHANGE"]);
  });

  it("fails a step-down whose floor change lands in the same change", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ minSeverities: { "no-console": "error" } }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_CONFIG, configYaml({ minSeverities: { "no-console": "warn" } }));
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "warn" }));
    r.commit("both");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    // Judged against the baseline's `error` floor, so the staged `warn` buys
    // nothing — and both facts are on the record.
    assert.deepEqual(codes(res.record), ["POLICY_CHANGE", "SEVERITY_FLOOR"]);
    assert.equal(res.record?.summary.policy.minSeverities?.["no-console"], "error");
  });

  it("does not fire for a severity declaration deleted outright (the documented hole)", () => {
    // Stated as a known limit in the config reference, so pin the shape it
    // describes: the head is undeclared, so there is no band to compare and
    // neither the floor nor the existing policy-change detection fires.
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "warn" }));
    r.write(PROTECTED_CONFIG, configYaml({ minSeverities: { "no-console": "error" } }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({}));
    r.commit("delete the declaration");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.deepEqual(codes(res.record), []);
  });

  it("fails when a severity drop is paired with new directive debt for the same rule", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "warn" }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.verdict, "fail");
  });

  it("fails when a warn drop is consumed by new debt for another governed rule", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "warn", "no-debugger": "error" }),
    );
    r.write("app.js", `${noDebugger}\ndebugger;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
    assert.equal(res.record?.verdict, "fail");
  });
});
