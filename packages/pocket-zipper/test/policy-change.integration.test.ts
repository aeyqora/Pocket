import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRepo,
  configYaml,
  eslintConfig,
  exceptionYaml,
  hasErrorCode,
  NEXT_LINE_NO_CONSOLE_FP,
  NEXT_LINE_NO_DEBUGGER_FP,
  type FixtureRepo,
} from "./harness.js";
import { addDuration } from "../src/policy.js";

const repos: FixtureRepo[] = [];
after(() => repos.forEach((r) => r.cleanup()));

function repo(): FixtureRepo {
  const r = createRepo();
  repos.push(r);
  return r;
}

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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: false }));
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });

  it("fails when removal of an explicitly-true enabled key is consumed", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(".pocket-zipper/config.yml", "# policy unchanged beyond removing the flag\n");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "POLICY_CHANGE"));
  });

  it("does not fire when no protected file is touched", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write(
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: false }));
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
      ".pocket-zipper/config.yml",
      configYaml({ governedRules: ["no-console", "no-debugger"] }),
    );
    r.write(
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-debugger"] }));
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
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-debugger"] }));
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.write(
      ".pocket-zipper/exceptions.yml",
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
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write(
      ".pocket-zipper/exceptions.yml",
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
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    // No code change, no debt, no directive — the change is the registry, and
    // the registry is malformed. Today this lands with `errors: []` and exit
    // 0: the one shape in which a broken registry merges.
    r.write(".pocket-zipper/exceptions.yml", MALFORMED_REGISTRY);
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    // The same malformed registry, beside debt the change introduced. A file
    // that cannot be read has no delta to judge, so this change has nothing to
    // report about policy at all — one tier of error, not two.
    r.write(".pocket-zipper/exceptions.yml", MALFORMED_REGISTRY);
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write(
      ".pocket-zipper/exceptions.yml",
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
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write(
      ".pocket-zipper/exceptions.yml",
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
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    // A pure policy PR: a well-formed record the baseline registry did not
    // carry, and no debt beside it. It is recorded rather than refused, and the
    // shape is named on this side of the gate too. The date is inside the
    // maximum, so the expiry policy has nothing to say about it.
    r.write(
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ enabled: true }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      ".pocket-zipper/exceptions.yml",
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
    r.write(".pocket-zipper/config.yml", configYaml({ governedRules: ["no-debugger"] }));
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
