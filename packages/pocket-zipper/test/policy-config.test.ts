import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  configYaml,
  eslintConfig,
  repo,
  cleanupRepos,
  PROTECTED_CONFIG,
} from "./harness.js";
import type { FixtureRepo } from "./harness.js";
import {
  DEFAULT_POLICY,
  addDuration,
  isDurationLiteral,
  parsePolicy,
  viewPolicy,
} from "../src/policy.js";
import type { EvaluationRecord, Policy } from "../src/types.js";

after(cleanupRepos);

const KNOWN = new Set(["no-console"]);

function assertConfigError(
  run: () => Policy,
  messagePattern: RegExp | string,
): void {
  assert.throws(run, (err: unknown) => {
    const e = err as { code?: string; message?: string };
    assert.equal(e.code, "CONFIG_ERROR");
    if (typeof messagePattern === "string") {
      assert.ok(e.message?.includes(messagePattern), `message ${JSON.stringify(e.message)} lacks ${messagePattern}`);
    } else {
      assert.match(e.message ?? "", messagePattern);
    }
    return true;
  });
}

describe("policy: exceptions stanza parsing", () => {
  it("parses per-rule minimum severity floors", () => {
    const policy = parsePolicy(
      "minSeverities:\n  no-console: warn\n  no-debugger: off\n",
      new Set(["no-console", "no-debugger"]),
    );
    assert.deepEqual(policy.minSeverities, { "no-console": "warn", "no-debugger": "off" });
  });

  it("rejects malformed severity floors and still validates them when disabled", () => {
    assertConfigError(
      () => parsePolicy("minSeverities: warn\n", KNOWN),
      /'minSeverities'/,
    );
    assertConfigError(
      () => parsePolicy("minSeverities:\n  no-console: notice\n", KNOWN),
      /'minSeverities'/,
    );
    assertConfigError(
      () => parsePolicy("enabled: false\nminSeverities:\n  no-console: notice\n", KNOWN),
      /'minSeverities'/,
    );
  });

  it("applies the canonical fallbacks for an absent file", () => {
    assert.deepEqual(parsePolicy(null, KNOWN), DEFAULT_POLICY);
  });

  it("applies the canonical fallbacks for an empty or comment-only file", () => {
    assert.deepEqual(parsePolicy("", KNOWN), DEFAULT_POLICY);
    assert.deepEqual(parsePolicy("# only a comment\n", KNOWN), DEFAULT_POLICY);
  });

  it("applies the can-guarantee-safe defaults when the stanza key is entirely absent", () => {
    const policy = parsePolicy("enabled: true\n", KNOWN);
    assert.deepEqual(policy.exceptions, { defaultExpiry: "30d", maxExpiry: "3mo" });
    assert.equal(policy.allowSameChangeExceptions, false);
    assert.equal(policy.host, null);
  });

  it("parses an explicitly configured stanza", () => {
    const policy = parsePolicy(configYaml({ defaultExpiry: "45d", maxExpiry: "90d" }), KNOWN);
    assert.deepEqual(policy.exceptions, { defaultExpiry: "45d", maxExpiry: "90d" });
  });

  it("falls back per missing key", () => {
    const onlyDefault = parsePolicy(configYaml({ defaultExpiry: "45d" }), KNOWN);
    assert.deepEqual(onlyDefault.exceptions, { defaultExpiry: "45d", maxExpiry: "3mo" });
    const onlyMax = parsePolicy(configYaml({ maxExpiry: "6mo" }), KNOWN);
    assert.deepEqual(onlyMax.exceptions, { defaultExpiry: "30d", maxExpiry: "6mo" });
  });

  it("applies fallbacks for an empty stanza", () => {
    assert.deepEqual(parsePolicy("enabled: true\nexceptions:\n", KNOWN).exceptions, {
      defaultExpiry: "30d",
      maxExpiry: "3mo",
    });
    assert.deepEqual(parsePolicy("enabled: true\nexceptions: {}\n", KNOWN).exceptions, {
      defaultExpiry: "30d",
      maxExpiry: "3mo",
    });
  });

  it("accepts a one-year as 12mo", () => {
    const policy = parsePolicy(configYaml({ defaultExpiry: "12mo", maxExpiry: "12mo" }), KNOWN);
    assert.deepEqual(policy.exceptions, { defaultExpiry: "12mo", maxExpiry: "12mo" });
  });

  it("rejects an uppercase literal naming the key and the valid forms", () => {
    assertConfigError(
      () => parsePolicy(configYaml({ defaultExpiry: "30D" }), KNOWN),
      /'exceptions\.defaultExpiry'.*30d, 3mo/,
    );
  });

  it("rejects a bare integer literal", () => {
    assertConfigError(
      () => parsePolicy(configYaml({ defaultExpiry: "30" }), KNOWN),
      /'exceptions\.defaultExpiry'/,
    );
  });

  it("rejects an ISO duration literal", () => {
    assertConfigError(
      () => parsePolicy(configYaml({ maxExpiry: "P3M" }), KNOWN),
      /'exceptions\.maxExpiry'/,
    );
  });

  it("rejects a bare unit or fractional literal", () => {
    assertConfigError(
      () => parsePolicy(configYaml({ defaultExpiry: "3m" }), KNOWN),
      /'exceptions\.defaultExpiry'/,
    );
    assertConfigError(
      () => parsePolicy(configYaml({ maxExpiry: "3.5d" }), KNOWN),
      /'exceptions\.maxExpiry'/,
    );
  });

  it("rejects a stanza that is not a mapping", () => {
    assertConfigError(
      () => parsePolicy("enabled: true\nexceptions: 30d\n", KNOWN),
      /'exceptions'/,
    );
    assertConfigError(
      () => parsePolicy("enabled: true\nexceptions: [30d]\n", KNOWN),
      /'exceptions'/,
    );
  });

  it("rejects unknown keys at the top level", () => {
    assertConfigError(
      () => parsePolicy("enabled: true\nfoo: 1\n", KNOWN),
      /unknown key 'foo'/,
    );
  });

  it("rejects unknown keys inside the stanza", () => {
    assertConfigError(
      () => parsePolicy("enabled: true\nexceptions:\n  defaultExpiry: 30d\n  bar: 1\n", KNOWN),
      /unknown key 'exceptions\.bar'/,
    );
  });

  it("rejects a self-contradicting policy (defaultExpiry > maxExpiry)", () => {
    assertConfigError(
      () => parsePolicy(configYaml({ defaultExpiry: "3mo", maxExpiry: "30d" }), KNOWN),
      /'defaultExpiry'.*exceeds 'maxExpiry'/,
    );
  });

  it("allows defaultExpiry equal to maxExpiry", () => {
    const policy = parsePolicy(configYaml({ defaultExpiry: "1mo", maxExpiry: "30d" }), KNOWN);
    assert.deepEqual(policy.exceptions, { defaultExpiry: "1mo", maxExpiry: "30d" });
  });

  it("runs structural validation even when enabled is false", () => {
    assertConfigError(
      () => parsePolicy("enabled: false\nexceptions:\n  defaultExpiry: 30D\n", KNOWN),
      /'exceptions\.defaultExpiry'/,
    );
    assertConfigError(
      () => parsePolicy("enabled: false\nstray: 1\n", KNOWN),
      /unknown key 'stray'/,
    );
    assertConfigError(
      () => parsePolicy("enabled: false\ngovernedRules: [1, 2]\n", KNOWN),
      /'governedRules' must be a list/,
    );
    assertConfigError(
      () => parsePolicy("enabled: false\nexceptions:\n  defaultExpiry: 3mo\n  maxExpiry: 30d\n", KNOWN),
      /exceeds 'maxExpiry'/,
    );
  });

  it("skips only the ESLint-dependent allowlist check when disabled", () => {
    const policy = parsePolicy(
      "enabled: false\ngovernedRules: [no-such-rule-xyz]\n",
      KNOWN,
    );
    assert.equal(policy.enabled, false);
    assert.deepEqual(policy.governedRules, ["no-such-rule-xyz"]);
  });

  it("still runs the allowlist rule check when enabled", () => {
    assertConfigError(
      () => parsePolicy("enabled: true\ngovernedRules: [no-such-rule-xyz]\n", KNOWN),
      /unrecognized ESLint rule 'no-such-rule-xyz'/,
    );
  });

  it("parses allowSameChangeExceptions as a typed boolean", () => {
    // The opt-in is paired with a can-guarantee host in the accepting cases,
    // because the pair is what the key means: `true` on its own is now a
    // self-contradicting config, and the type check is judged before that one.
    assert.equal(
      parsePolicy("allowSameChangeExceptions: true\nhost: github\n", KNOWN)
        .allowSameChangeExceptions,
      true,
    );
    assert.equal(parsePolicy("allowSameChangeExceptions: false\n", KNOWN).allowSameChangeExceptions, false);
    assertConfigError(
      () => parsePolicy("allowSameChangeExceptions: \"true\"\n", KNOWN),
      /'allowSameChangeExceptions' must be a boolean/,
    );
    assertConfigError(
      () => parsePolicy("allowSameChangeExceptions: 1\n", KNOWN),
      /'allowSameChangeExceptions' must be a boolean/,
    );
  });

  it("parses host as a typed enum", () => {
    assert.equal(parsePolicy("host: github\n", KNOWN).host, "github");
    assert.equal(parsePolicy("host: gitlab-premium\n", KNOWN).host, "gitlab-premium");
    assert.equal(parsePolicy("host: bitbucket-server\n", KNOWN).host, "bitbucket-server");
    assertConfigError(() => parsePolicy("host: github-pages\n", KNOWN), /'host' must be one of/);
    assertConfigError(() => parsePolicy("host: 123\n", KNOWN), /'host' must be one of/);
  });

  it("host without combined is a valid forward declaration", () => {
    const policy = parsePolicy("host: github\nallowSameChangeExceptions: false\n", KNOWN);
    assert.equal(policy.host, "github");
    assert.equal(policy.allowSameChangeExceptions, false);
  });

  it("viewPolicy stays a tolerant, non-throwing view", () => {
    const view = viewPolicy("enabled: true\nstray: 1\nexceptions:\n  defaultExpiry: 99\n");
    assert.equal(view.malformed, false);
    assert.equal(view.enabled, true);
    assert.deepEqual(view.topLevelUnknown, ["stray"]);
    assert.equal(view.exceptions.defaultExpiryValid, false);
    assert.equal(view.exceptions.maxExpiryValid, true);
  });

  it("recognizes duration literals exactly", () => {
    for (const ok of ["1d", "30d", "365d", "1mo", "12mo", "1000mo"]) {
      assert.equal(isDurationLiteral(ok), true, ok);
    }
    for (const bad of ["", "d", "mo", "30", "30D", "30M", "3m", "P3M", "1.5d", "30 d", "-1d", "0x1d"]) {
      assert.equal(isDurationLiteral(bad), false, bad);
    }
  });
});

describe("policy: duration arithmetic", () => {
  it("adds exact days", () => {
    assert.equal(addDuration("2026-01-15", "30d"), "2026-02-14");
    assert.equal(addDuration("2026-12-15", "30d"), "2027-01-14");
  });

  it("adds calendar months clamping to month end", () => {
    assert.equal(addDuration("2026-05-31", "1mo"), "2026-06-30");
    assert.equal(addDuration("2026-01-31", "1mo"), "2026-02-28");
    assert.equal(addDuration("2024-01-31", "1mo"), "2024-02-29");
    assert.equal(addDuration("2026-12-15", "3mo"), "2027-03-15");
    assert.equal(addDuration("2026-01-01", "12mo"), "2027-01-01");
    assert.equal(addDuration("2024-02-29", "12mo"), "2025-02-28");
    assert.equal(addDuration("2024-02-29", "1mo"), "2024-03-29");
  });
});

describe("policy config through the CLI fixture seam", () => {
  /** A repo whose baseline carries `config`; `check --base base` is run against it. */
  function baselineWithConfig(config: string): FixtureRepo {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write(PROTECTED_CONFIG, config);
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    return r;
  }

  function expectCliConfigError(r: FixtureRepo, messagePattern: RegExp): void {
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR", res.stderr);
    assert.match(res.record?.errors[0]?.message ?? "", messagePattern);
  }

  it("reads a valid exceptions stanza cleanly", () => {
    const r = baselineWithConfig(configYaml({ defaultExpiry: "45d", maxExpiry: "90d" }));
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.errors, []);
  });

  it("reads a greenfield repo with no config cleanly", () => {
    const r = repo();
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.commit("base");
    r.branch("base");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.errors, []);
    assert.deepEqual(res.record?.summary.policy, { enabled: true, allowlist: null });
  });

  it("reads fallbacks cleanly with a partial stanza", () => {
    const r = baselineWithConfig(configYaml({ defaultExpiry: "45d" }));
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.errors, []);
  });

  it("fails closed on a malformed duration literal", () => {
    expectCliConfigError(
      baselineWithConfig(configYaml({ defaultExpiry: "30D" })),
      /'exceptions\.defaultExpiry'.*30d, 3mo/,
    );
  });

  it("fails closed on an unknown top-level key", () => {
    expectCliConfigError(
      baselineWithConfig("enabled: true\nwhatsthis: 1\n"),
      /unknown key 'whatsthis'/,
    );
  });

  it("fails closed on an unknown key inside the stanza", () => {
    expectCliConfigError(
      baselineWithConfig("enabled: true\nexceptions:\n  defaultExpiry: 30d\n  expiryUnit: days\n"),
      /unknown key 'exceptions\.expiryUnit'/,
    );
  });

  it("fails closed on a self-contradicting policy", () => {
    expectCliConfigError(
      baselineWithConfig(configYaml({ defaultExpiry: "3mo", maxExpiry: "30d" })),
      /exceeds 'maxExpiry'/,
    );
  });

  it("fails closed on a broken config even when enabled is false", () => {
    const r = baselineWithConfig("enabled: false\nexceptions:\n  maxExpiry: 3M\n");
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 2);
    assert.equal(res.record?.verdict, "fail");
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
    assert.match(res.record?.errors[0]?.message ?? "", /'exceptions\.maxExpiry'/);
  });

  it("fails closed on a mistyped allowSameChangeExceptions", () => {
    expectCliConfigError(
      baselineWithConfig('allowSameChangeExceptions: "yes"\n'),
      /'allowSameChangeExceptions' must be a boolean/,
    );
  });

  it("fails closed on an invalid host", () => {
    expectCliConfigError(
      baselineWithConfig("host: github-enterprise\n"),
      /'host' must be one of/,
    );
  });

  it("parses the pair as typed keys without combined-landing semantics yet (ticket 07)", () => {
    const r = baselineWithConfig(
      configYaml({ allowSameChangeExceptions: true, host: "github" }),
    );
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.errors, []);
  });

  it("writes the parsed policy fields into the JSON record's summary", () => {
    const r = baselineWithConfig(configYaml({ enabled: true, governedRules: ["no-console"] }));
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.summary.policy, { enabled: true, allowlist: ["no-console"] });
  });

  it("an enabled-off-but-well-formed config still evaluates nothing", () => {
    const r = baselineWithConfig(configYaml({ enabled: false }));
    const res = r.runCli(["check", "--base", "base"]);
    assert.equal(res.status, 0);
    assert.equal((res.record as EvaluationRecord | null)?.verdict, "excluded");
    assert.deepEqual(res.record?.errors, []);
  });
});
