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
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";
import { addDuration } from "../src/policy.js";

after(cleanupRepos);

const disabled = "// eslint-disable-next-line no-console\n";
const nextLineNoDebugger = "// eslint-disable-next-line no-debugger\n";

/** Real today, and the dates the expiry policy is judged against (default 3mo max). */
const TODAY = new Date().toISOString().slice(0, 10);
const IN_WINDOW = addDuration(TODAY, "30d");
const BEYOND_HORIZON = addDuration(TODAY, "6mo");
const BEYOND_FAR = addDuration(TODAY, "12mo");
const LONG_PAST = "2000-01-01";

function expiryPolicyCount(record: { errors: Array<{ code: string }> } | null): number {
  return record?.errors.filter((e) => e.code === "EXPIRY_POLICY").length ?? 0;
}

function baseRecord(overrides: Partial<Parameters<typeof exceptionYaml>[0]> = {}) {
  return exceptionYaml({
    rule: "no-console",
    suppressionType: "next-line",
    fingerprint: NEXT_LINE_NO_CONSOLE_FP,
    file: "app.js",
    type: "temporary",
    expires: "2099-01-01",
    ...overrides,
  });
}

/**
 * A file carrying N identical `no-console` directives: N same-file twins, which
 * identity cannot tell apart, so they share one fingerprint and form one pool.
 */
function twinFile(n: number): string {
  return Array.from({ length: n }, (_, i) => `${disabled}console.log(${i});\n`).join("");
}

/** N records for one twin pool, as the one-record-per-suppression shape requires. */
function twinRecords(n: number): string {
  return Array.from({ length: n }, () => baseRecord()).join("");
}

describe("the exception registry, resolved against the baseline", () => {
  it("authorizes exactly one logical suppression", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord());
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    const entry = res.record?.inventory.find((e) => e.disposition === "new");
    assert.equal(entry?.exception?.fingerprint, NEXT_LINE_NO_CONSOLE_FP);
    assert.equal(res.record?.exceptions[0]?.status, "used");
  });

  it("does not authorize a suppression on a different rule", () => {
    const r = repo();
    r.write(
      "eslint.config.mjs",
      eslintConfig({ "no-console": "error", "no-debugger": "error" }),
    );
    r.write(
      PROTECTED_REGISTRY,
      baseRecord({ rule: "no-debugger", fingerprint: NEXT_LINE_NO_DEBUGGER_FP }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    assert.equal(res.record?.summary.cleanup.danglingExceptions, 1);
  });

  it("does not let an exception in the same change authorize anything", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_REGISTRY, baseRecord());
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 0);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
  });

  it("reports a matching suppression in another file as unauthorized debt", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord({ file: "other.js" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 0);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    assert.equal(res.record?.inventory.find((e) => e.disposition === "new")?.exception, null);
    assert.equal(res.record?.summary.cleanup.danglingExceptions, 1);
    assert.equal(res.record?.exceptions[0]?.status, "dangling");
  });

  it("keeps an expired record expired when its lookalike is in another file", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      PROTECTED_REGISTRY,
      baseRecord({ file: "other.js", expires: "2000-01-01" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    assert.equal(res.record?.summary.cleanup.expiredExceptions, 1);
    assert.equal(res.record?.exceptions[0]?.status, "expired");
  });

  it("reports a tomb in another file as debt, not a registry configuration error", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord());
    r.write("app.js", "export const a = 1;\n");
    r.write("legacy.js", `${disabled}console.log("dead");\n`);
    r.commit("base");
    r.branch("base");
    r.write("legacy.js", `work();\nfeature();\n${disabled}console.log("brand-new");\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.dispositions.materiallyChanged, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    assert.equal(
      res.record?.inventory.find((e) => e.disposition === "materially-changed")?.exception,
      null,
    );
    assert.equal(res.record?.summary.cleanup.danglingExceptions, 1);
    assert.equal(res.record?.errors.length, 0);
  });

  it("does not spend a record on an existing suppression in another file", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord());
    r.write("app.js", "export const a = 1;\n");
    r.write("legacy.js", `${disabled}console.log("legacy");\n`);
    r.commit("base");
    r.branch("base");
    r.write("legacy.js", `${disabled}console.log("legacy");\nexport const tail = 1;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(
      res.record?.inventory.find((e) => e.file === "legacy.js")?.disposition,
      "existing",
    );
    assert.equal(res.record?.summary.cleanup.danglingExceptions, 1);
    assert.equal(res.record?.summary.cleanup.spentExceptions, 0);
    assert.equal(res.record?.exceptions[0]?.status, "dangling");
  });

  it("does not spend a record when another file's matching suppression merely moved", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord());
    r.write("app.js", "export const a = 1;\n");
    r.write("legacy.js", `export const l = 1;\n${disabled}console.log("legacy");\n`);
    r.commit("base");
    r.branch("base");
    r.write(
      "legacy.js",
      `export const l = 1;\nexport const m = 2;\n${disabled}console.log("legacy");\n`,
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(
      res.record?.inventory.find((e) => e.file === "legacy.js")?.disposition,
      "moved-existing",
    );
    assert.equal(res.record?.summary.cleanup.danglingExceptions, 1);
    assert.equal(res.record?.summary.cleanup.spentExceptions, 0);
    assert.equal(res.record?.exceptions[0]?.status, "dangling");
  });

  it("fails closed on a malformed registry", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, "- rule: no-console\n  type: temporary\n");
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
  });

  it("proceeds with enforcement when the registry is empty", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, "");
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
  });

  it("proceeds with enforcement when no registry file exists", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
  });

  it("treats a renewal in the same change as a fresh authorization", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: "2000-01-01" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: "2099-01-01" }));
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 0);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    assert.equal(res.record?.summary.cleanup.expiredExceptions, 1);
  });

  it("treats temporary-to-permanent in the same change as a fresh authorization", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: "2000-01-01" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(
      PROTECTED_REGISTRY,
      baseRecord({ type: "permanent", expires: undefined }),
    );
    r.write("app.js", `${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 0);
  });

  it("fails closed on invalid record fields", () => {
    const valid = `- rule: no-console\n  suppression_type: next-line\n  fingerprint: ${NEXT_LINE_NO_CONSOLE_FP}\n  file: app.js\n  type: permanent\n  reason: r\n  reference: ref\n`;
    const without = (line: string) => valid.replace(line, "");
    const cases: Array<{ name: string; yaml: string; field: RegExp }> = [
      { name: "invalid type", yaml: valid.replace("type: permanent", "type: whenever"), field: /type/ },
      {
        name: "temporary without expires",
        yaml: valid.replace("type: permanent", "type: temporary"),
        field: /expires/,
      },
      {
        name: "non-exceptable config-off type",
        yaml: valid.replace("suppression_type: next-line", "suppression_type: config-off"),
        field: /suppression_type/,
      },
      { name: "permanent with expires", yaml: valid + "  expires: 2099-01-01\n", field: /expires/ },
      { name: "missing reason", yaml: without("  reason: r\n"), field: /reason/ },
      { name: "line below 1", yaml: valid + "  line: 0\n", field: /line/ },
      { name: "non-integer line", yaml: valid + "  line: 4.5\n", field: /line/ },
      {
        name: "invalid expires date",
        yaml: valid.replace("type: permanent", "type: temporary") + "  expires: not-a-date\n",
        field: /expires/,
      },
    ];
    for (const c of cases) {
      const r = repo();
      r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
      r.write(PROTECTED_REGISTRY, c.yaml);
      r.write("app.js", "export const a = 1;\n");
      r.commit("base");
      r.branch("base");
      const res = r.runCli(["check", "--base", "base"]);
      assert.equal(res.status, 2, c.name);
      assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR", c.name);
      assert.match(res.record?.errors[0]?.message ?? "", c.field, c.name);
    }
  });

  it("fails closed on a stale owner, naming the removed field", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(
      PROTECTED_REGISTRY,
      baseRecord().replace('  reference: "#1"', '  reference: "#1"\n  owner: "@team"'),
    );
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
    assert.match(
      res.record?.errors[0]?.message ?? "",
      /unknown field 'owner' — removed from the registry format; delete this line/,
    );
  });

  it("authorizes a record carrying a line", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord({ line: 2 }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
  });
});

/**
 * A pool of same-file twins through the gate. The twins are indistinguishable
 * to identity, so one record cannot cover two of them: the count line and
 * `summary.cleanup.poolCounts` are what make the bookkeeping legible.
 */
describe("one record authorizes one twin", () => {
  it("leaves the twin no record covers unauthorized, and states the arithmetic", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord());
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${twinFile(2)}`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 1);
    const newDebt = res.record?.inventory.filter((e) => e.disposition === "new") ?? [];
    assert.equal(newDebt.length, 2);
    assert.equal(newDebt.filter((e) => e.exception !== null).length, 1);
    // The count line is on a fail and without --verbose, so the registry's side of
    // the story is where the reader lands. It shows the record fully used; the
    // shortfall is the twin that balances the pool and still carries no
    // exception, which the disposition summary right above it accounts for.
    assert.match(
      res.stdout,
      /^For this rule at this file: 1 matching records, 1 used, 0 leftover$/m,
    );
    assert.deepEqual(res.record?.summary.cleanup.poolCounts, [
      { rule: "no-console", file: "app.js", matched: 1, used: 1, leftover: 0 },
    ]);
  });

  it("passes a record per twin, and prints the arithmetic only on a verbose pass", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, twinRecords(2));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${twinFile(2)}`);
    r.commit("head");
    const plain = r.runCli(["check", "--base", "base"]);
    assert.equal(plain.status, 0);
    assert.equal(plain.record?.summary.newDebt.authorized, 2);
    assert.equal(plain.record?.summary.cleanup.danglingExceptions, 0);
    // A well-kept pool balances, so a quiet pass says nothing about it: the
    // arithmetic is an answer for a gate that failed, not a standing comment.
    assert.equal(plain.stdout, "pocket-zipper: PASS\n");
    // The same scenario, asked for the detail.
    assert.deepEqual(plain.record?.summary.cleanup.poolCounts, [
      { rule: "no-console", file: "app.js", matched: 2, used: 2, leftover: 0 },
    ]);
    const verbose = r.runCli(["check", "--base", "base", "--verbose"]);
    assert.equal(verbose.status, 0);
    assert.match(
      verbose.stdout,
      /^For this rule at this file: 2 matching records, 2 used, 0 leftover$/m,
    );
  });

  it("records one count per (rule, file) pool, ordered by rule then file", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error", "no-debugger": "error" }));
    r.write(
      PROTECTED_REGISTRY,
      baseRecord({ file: "app.js" }) +
        baseRecord({ file: "tools.js" }) +
        baseRecord({ rule: "no-debugger", fingerprint: NEXT_LINE_NO_DEBUGGER_FP, file: "old.js" }),
    );
    r.write("app.js", "export const a = 1;\n");
    r.write("tools.js", "export const b = 1;\n");
    r.write("old.js", "export const c = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.write("tools.js", `export const b = 1;\n${disabled}console.log(2);\n`);
    r.write("old.js", `export const c = 1;\n${nextLineNoDebugger}debugger;\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.newDebt.authorized, 3);
    // Three pools, ordered by rule then file. Sorting by file first would read
    // app.js, old.js, tools.js, so the order is the assertion, not decoration.
    assert.deepEqual(res.record?.summary.cleanup.poolCounts, [
      { rule: "no-console", file: "app.js", matched: 1, used: 1, leftover: 0 },
      { rule: "no-console", file: "tools.js", matched: 1, used: 1, leftover: 0 },
      { rule: "no-debugger", file: "old.js", matched: 1, used: 1, leftover: 0 },
    ]);
  });
});

/**
 * The expiry policy, judged against the baseline's maximum. A date past the
 * max in the baseline is overlong hygiene that still authorizes; the same date
 * newly written in the head is `EXPIRY_POLICY`, a refusal that fails the
 * change writing it. Every fixture here keeps the two apart the way the rule
 * does: whether a record's date was written on the baseline side or the head
 * side of the diff decides the outcome, nothing else.
 */
describe("the expiry policy, judged against the baseline maximum", () => {
  it("refuses a newly written record past the maximum", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: BEYOND_HORIZON }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    // The change is the registry alone — no suppression anywhere — so the
    // exit is the refusal's, and one refusing record is one error (D2).
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    assert.ok(hasErrorCode(res.record, "EXPIRY_POLICY"));
    assert.equal(expiryPolicyCount(res.record), 1);
  });

  it("refuses a renewal past the maximum", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: IN_WINDOW }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: BEYOND_HORIZON }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    assert.ok(hasErrorCode(res.record, "EXPIRY_POLICY"));
    assert.equal(expiryPolicyCount(res.record), 1);
  });

  it("bumping the maximum in the same change legalizes nothing", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ maxExpiry: "3mo" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_CONFIG, configYaml({ maxExpiry: "12mo" }));
    // Six months from today: comfortably inside a 12mo policy, past the
    // baseline's 3mo. The baseline's maximum is the only one that binds.
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: BEYOND_HORIZON }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.ok(hasErrorCode(res.record, "EXPIRY_POLICY"));
  });

  it("keeps an overlong baseline record authorizing, and reports it", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: BEYOND_HORIZON }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal(res.record?.summary.newDebt.authorized, 1);
    assert.equal(res.record?.summary.cleanup.overlongExceptions, 1);
    assert.ok(!hasErrorCode(res.record, "EXPIRY_POLICY"));
    // The count reaches the report on a verbose pass and on a FAIL (below).
    const verbose = r.runCli(["check", "--base", "base", "--verbose"]);
    assert.equal(verbose.status, 0);
    assert.match(
      verbose.stdout,
      /^  Overlong exceptions: 1 \(expires past the 3mo maximum\)$/m,
    );
  });

  it("does not refuse an overlong record the change never writes", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: BEYOND_HORIZON }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    // The registry is untouched; only a bystander file moves. The same date
    // that refused in the head-only fixture above stays hygiene here, because
    // which side of the diff wrote it is the whole question.
    r.write("other.js", "export const b = 1;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(!hasErrorCode(res.record, "EXPIRY_POLICY"));
    assert.equal(res.record?.summary.cleanup.overlongExceptions, 1);
  });

  it("lets a non-date edit to an overlong record pass under the tightened maximum", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, configYaml({ maxExpiry: "6mo" }));
    // Landed under a 6mo policy, then the change tightens the maximum to 3mo.
    // The record runs a year out, so it is past *both* maxima — which is what
    // keeps the overlong count at 1: the count reads the baseline's maximum, so
    // a record only stops counting as overlong once the *baseline* catches up,
    // never when the head tightens. A date merely past the new 3mo would sit
    // inside the baseline's 6mo and count 0, testing nothing here.
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: BEYOND_FAR }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_CONFIG, configYaml({ maxExpiry: "3mo" }));
    // The only registry edit is a `reason` — no date is written, so there is
    // nothing for the expiry policy to newly write and refuse.
    r.write(
      PROTECTED_REGISTRY,
      baseRecord({ expires: BEYOND_FAR }).replace(
        "  reason: needed",
        "  reason: clarified in review",
      ),
    );
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.ok(!hasErrorCode(res.record, "EXPIRY_POLICY"));
    assert.equal(res.record?.summary.cleanup.overlongExceptions, 1);
  });

  it("refuses a partial-credit renewal that is shorter but still past the maximum", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: BEYOND_FAR }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: BEYOND_HORIZON }));
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 1);
    assert.equal(res.record?.summary.newDebt.unauthorized, 0);
    assert.ok(hasErrorCode(res.record, "EXPIRY_POLICY"));
    // The FAIL report carries the baseline record's overlong count and the
    // refusal its renewal earned.
    assert.match(
      res.stdout,
      /^  Overlong exceptions: 1 \(expires past the 3mo maximum\)$/m,
    );
  });

  it("counts a long-expired record as expired, never overlong", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_REGISTRY, baseRecord({ expires: LONG_PAST }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    r.write("other.js", "export const b = 1;\n");
    r.commit("head");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    // Expired takes precedence over overlong — asserted negatively, because a
    // record cannot be both (the two predicates contradict).
    assert.equal(res.record?.summary.cleanup.expiredExceptions, 1);
    assert.equal(res.record?.summary.cleanup.overlongExceptions, 0);
    assert.ok(!hasErrorCode(res.record, "EXPIRY_POLICY"));
  });
});
