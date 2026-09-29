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
  type RunResult,
} from "./harness.js";
import { addDuration, parsePolicy } from "../src/policy.js";

/**
 * The guarded one-PR opt-in: a repo whose **baseline** config declares
 * `allowSameChangeExceptions` with a host that can guarantee a distinct,
 * path-scoped approval for `.pocket-zipper/**` may land an *additive* record
 * in the ordinary change the record authorizes — one PR, no `POLICY_CHANGE`.
 * Everything else stays on the protected track, and the opt-in is read from
 * the baseline, so flipping it on in the same change legalizes nothing.
 *
 * The seam is the CLI throughout: exit codes, `errors[]` codes and messages,
 * and the JSON's own counts and statuses. A line number is never an identity
 * here, and neither is which record paired with which — the observable for a
 * cross-file re-point is the clause on the `POLICY_CHANGE` line.
 */

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
 * is named: the first half is ticket 06's wording and must not move, the
 * second is the clause that says what the registry did.
 */
const CONSUMED = "policy weakening consumed by new suppression debt in the same change";
const ADDITIVE_CLAUSE =
  ": a new exception record authorizes debt the baseline registry did not";
const EDIT_CLAUSE =
  ": an existing exception record's identity changed, so it now authorizes different debt";

const TODAY = new Date().toISOString().slice(0, 10);
/** Inside the 3mo default maximum: the date a passing pure policy PR writes. */
const WITHIN_HORIZON = addDuration(TODAY, "1mo");
/** Past it: the date a change that is refused for its expiry writes. */
const BEYOND_HORIZON = addDuration(TODAY, "6mo");
/** Well past it: a temporary that authorizes nothing. */
const LONG_PAST = "2000-01-01";

/**
 * A registry the loader rejects: a record carrying two of its nine fields.
 * Used where a *riding* record is unreadable, so the defect is beside the debt
 * a same-change record would have authorized.
 */
const MALFORMED_REGISTRY = "- rule: no-console\n  type: temporary\n";

/** The rules every fixture's flat config governs; `parsePolicy` validates against these. */
const KNOWN = new Set(["no-console", "no-debugger"]);

function record(opts: {
  rule?: string;
  file?: string;
  fingerprint?: string;
  type?: "temporary" | "permanent";
  expires?: string;
} = {}): string {
  const type = opts.type ?? "temporary";
  return exceptionYaml({
    rule: opts.rule ?? "no-console",
    suppressionType: "next-line",
    fingerprint: opts.fingerprint ?? NEXT_LINE_NO_CONSOLE_FP,
    file: opts.file ?? "app.js",
    type,
    ...(type === "temporary" ? { expires: opts.expires ?? WITHIN_HORIZON } : {}),
  });
}

/**
 * A repo on one of the two postures the groups below contrast, differing only
 * in the baseline config. Every head in a group varies only the delta, so the
 * variable is never the posture.
 */
function onBaseline(
  posture: "combined" | "two-step",
  opts: { registry?: string; app?: string; host?: string } = {},
): FixtureRepo {
  const r = repo();
  r.write(
    "eslint.config.mjs",
    eslintConfig({ "no-console": "error", "no-debugger": "error" }),
  );
  r.write(
    ".pocket-zipper/config.yml",
    posture === "combined"
      ? configYaml({ allowSameChangeExceptions: true, host: opts.host ?? "github" })
      : configYaml({ enabled: true }),
  );
  if (opts.registry) r.write(".pocket-zipper/exceptions.yml", opts.registry);
  r.write("app.js", opts.app ?? "export const a = 1;\n");
  r.commit("base");
  r.branch("base");
  return r;
}

/** A baseline already declaring the opt-in with a can-guarantee host. */
function combinedOnHost(
  opts: { registry?: string; app?: string; host?: string } = {},
): FixtureRepo {
  return onBaseline("combined", opts);
}

/** The same repo on a two-step baseline: the opt-in absent, the host undeclared. */
function twoStep(opts: { registry?: string; app?: string } = {}): FixtureRepo {
  return onBaseline("two-step", opts);
}

/**
 * The one head-side change the same-change-exception tests share: a record whose
 * match key the baseline registry does not carry, beside the debt it authorizes.
 * Only the baseline posture differs between them, which is the whole point of
 * running the identical proposed change twice.
 */
function rideAdditiveRecord(
  r: FixtureRepo,
  opts: { expires?: string; file?: string } = {},
): void {
  const file = opts.file ?? "app.js";
  r.write(".pocket-zipper/exceptions.yml", record({ expires: opts.expires, file }));
  r.write(file, `export const a = 1;\n${disabled}console.log(1);\n`);
}

function check(r: FixtureRepo): RunResult {
  return r.runCli(["check", "--base", "base"]);
}

function policyChangeMessage(
  result: { errors: Array<{ code: string; message: string }> } | null,
): string {
  const entry = result?.errors.find((e) => e.code === "POLICY_CHANGE");
  assert.ok(entry, "expected a POLICY_CHANGE entry");
  return entry.message;
}

function codes(result: { errors: Array<{ code: string }> } | null): string[] {
  return result?.errors.map((e) => e.code) ?? [];
}

describe("combined landing: the additive same-change exception", () => {
  it("authorizes an additive record in the ordinary change that consumes it, with no policy change", () => {
    const r = combinedOnHost();
    rideAdditiveRecord(r);
    r.commit("head");
    const res = check(r);
    assert.equal(res.status, 0);
    // One PR, and the second-PR signal is not raised: the host's path-scoped
    // approval on `.pocket-zipper/**` within this PR is what replaced it.
    assert.deepEqual(res.record?.errors, []);
    assert.deepEqual(res.record?.summary.newDebt, { authorized: 1, unauthorized: 0 });
    // The record is in the evaluation's registry, so it is published with the
    // status the allocator gave it — the answer to "why did this pass?".
    assert.deepEqual(
      res.record?.exceptions.map((e) => ({ fingerprint: e.fingerprint, status: e.status })),
      [{ fingerprint: NEXT_LINE_NO_CONSOLE_FP, status: "used" }],
    );
  });

  it("legalizes nothing when the same change turns the opt-in on", () => {
    const r = twoStep();
    r.write(
      ".pocket-zipper/config.yml",
      configYaml({ enabled: true, allowSameChangeExceptions: true, host: "github" }),
    );
    rideAdditiveRecord(r);
    r.commit("head");
    const res = check(r);
    // The evaluation reads the *baseline* policy, where the opt-in is off. The
    // head's own opt-in contributes nothing, so enabling combined is itself a
    // protected policy change: one merge before the first combined PR.
    assert.equal(res.status, 1);
    assert.equal(policyChangeMessage(res.record), `${CONSUMED}${ADDITIVE_CLAUSE}`);
    assert.deepEqual(res.record?.summary.newDebt, { authorized: 0, unauthorized: 1 });
  });

  it("refuses the identical change on a two-step baseline, so a same-change exception stays a posture and not a shape", () => {
    const r = twoStep();
    rideAdditiveRecord(r);
    r.commit("head");
    const res = check(r);
    // The anti-circumvention control. Nothing but the baseline config differs
    // from the test above; without this, a future edit that widened the union
    // to "any registry delta the change carries" would pass here unnoticed.
    assert.equal(res.status, 1);
    assert.equal(policyChangeMessage(res.record), `${CONSUMED}${ADDITIVE_CLAUSE}`);
    assert.deepEqual(res.record?.summary.newDebt, { authorized: 0, unauthorized: 1 });
  });

  it("reports a riding record with nothing consuming it as cleanup debt, not as a policy change", () => {
    const r = combinedOnHost();
    r.write(".pocket-zipper/exceptions.yml", record());
    r.commit("head");
    const res = check(r);
    // A record riding in a change that consumes nothing is still a record: it
    // is published, it is dangling, and it lands in the cleanup counts. Under
    // the same-change exception the change itself is the host's protected path,
    // so there is no second-PR signal to raise about it either.
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.errors, []);
    assert.deepEqual(res.record?.exceptions.map((e) => e.status), ["dangling"]);
    assert.equal(res.record?.summary.cleanup.danglingExceptions, 1);
    assert.deepEqual(res.record?.summary.newDebt, { authorized: 0, unauthorized: 0 });
  });

  it("keeps an identity edit on the protected track under combined landing", () => {
    const r = combinedOnHost({
      registry: record({ rule: "no-debugger", fingerprint: NEXT_LINE_NO_DEBUGGER_FP }),
    });
    // The one slot, re-pointed at different debt: the new record authorizes
    // something the baseline record did not, so the delta is an edit and the
    // exception — which reads the additive shape only — never applies.
    r.write(
      ".pocket-zipper/exceptions.yml",
      record({ expires: "2099-01-01" }),
    );
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = check(r);
    assert.equal(res.status, 1);
    assert.equal(policyChangeMessage(res.record), `${CONSUMED}${EDIT_CLAUSE}`);
    assert.deepEqual(res.record?.summary.newDebt, { authorized: 0, unauthorized: 1 });
  });

  it("refuses the identical identity edit on a two-step baseline", () => {
    const r = twoStep({
      registry: record({ rule: "no-debugger", fingerprint: NEXT_LINE_NO_DEBUGGER_FP }),
    });
    r.write(".pocket-zipper/exceptions.yml", record({ expires: "2099-01-01" }));
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = check(r);
    // "In both modes" is the ticket's wording, and it is two facts: the edit is
    // refused in either posture, and it is refused *as an edit* in the one
    // posture that would otherwise admit an additive grant.
    assert.equal(res.status, 1);
    assert.equal(policyChangeMessage(res.record), `${CONSUMED}${EDIT_CLAUSE}`);
    assert.deepEqual(res.record?.summary.newDebt, { authorized: 0, unauthorized: 1 });
  });

  it("keeps a renewal off the same-change exception: the baseline's expired record authorizes nothing", () => {
    const r = combinedOnHost({ registry: record({ expires: LONG_PAST }) });
    // A renewal re-points no slot, so the head record is not an addition and
    // never joins the union. What the coverage pass sees is the baseline's own
    // expired record, which authorizes nothing — the gate fails, and there is
    // no `POLICY_CHANGE` to point at, because the delta names no new grant.
    r.write(".pocket-zipper/exceptions.yml", record({ expires: WITHIN_HORIZON }));
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = check(r);
    assert.equal(res.status, 1);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), false);
    assert.deepEqual(res.record?.summary.newDebt, { authorized: 0, unauthorized: 1 });
  });

  it("refuses a renewal riding alongside a genuine additive grant, so the second record cannot launder it", () => {
    // The composite the two tests above each half of. On its own a renewal is
    // refused for the dull reason that nothing authorizes the debt. Alone, an
    // additive grant is exactly what the opt-in exists to allow. Together in
    // one change, the additive grant is legitimate and rides, so a union built
    // by file-and-match-key rather than by "what this change added" would pull
    // the renewed record in behind it and let one PR both renew and consume.
    const r = combinedOnHost({ registry: record({ expires: LONG_PAST }) });
    r.write(
      ".pocket-zipper/exceptions.yml",
      // The renewal, rewritten to a date inside the horizon.
      record({ expires: WITHIN_HORIZON }) +
        // A genuine additive record: a match key the baseline never carried.
        record({
          rule: "no-debugger",
          fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
          expires: WITHIN_HORIZON,
        }),
    );
    r.write(
      "app.js",
      `export const a = 1;\n${disabled}console.log(1);\n${noDebugger}debugger;\n`,
    );
    r.commit("head");
    const res = check(r);
    // The additive half is authorized — the opt-in is doing its job — and the
    // renewed half is not, because the baseline's own record had expired. The
    // exit is 1 on the unauthorized debt, not on a `POLICY_CHANGE`: the delta
    // names one new grant, and that grant is real.
    assert.equal(res.status, 1);
    assert.equal(hasErrorCode(res.record, "POLICY_CHANGE"), false);
    assert.deepEqual(res.record?.summary.newDebt, { authorized: 1, unauthorized: 1 });
    // The renewed record keeps the status the allocator gave it and never
    // reaches "used", which is the observable form of "it did not ride".
    const statuses = res.record?.exceptions.map((e) => e.status) ?? [];
    assert.equal(statuses.filter((s) => s === "used").length, 1);
  });

  it("refuses a riding record past the maximum and still credits it with the debt it authorizes", () => {
    const r = combinedOnHost();
    rideAdditiveRecord(r, { expires: BEYOND_HORIZON });
    r.commit("head");
    const res = check(r);
    // Two independent facts about one record. The date is refused because the
    // change newly writes it; the record still authorizes, because refusing a
    // record's date does not make the record invalid.
    assert.equal(res.status, 1);
    assert.deepEqual(codes(res.record).sort(), ["EXPIRY_POLICY"]);
    assert.deepEqual(res.record?.summary.newDebt, { authorized: 1, unauthorized: 0 });
  });

  it("leaves a removal alone posture-free, in either posture", () => {
    for (const build of [combinedOnHost, twoStep]) {
      const r = build({
        registry: record(),
        app: `export const a = 1;\n${disabled}console.log(1);\n`,
      });
      r.remove(".pocket-zipper/exceptions.yml");
      r.write("app.js", "export const a = 1;\n");
      r.commit("head");
      const res = check(r);
      // The record and the debt it covered both go. A removal never broadens
      // what the registry permits and never authorizes anything, so it is legal
      // in any PR in either posture — the same-change exception never has to be
      // consulted, and consulting it must not be what makes this pass.
      assert.equal(res.status, 0, build.name);
      assert.deepEqual(res.record?.errors, [], build.name);
      assert.deepEqual(res.record?.summary.newDebt, { authorized: 0, unauthorized: 0 }, build.name);
      // And the change *was* read, not merely tolerated: the record the author
      // dropped is published from the baseline registry and judged against the
      // head tree, where nothing matches it any more. An evaluation that
      // ignored the removal would still publish it as `used`.
      assert.deepEqual(res.record?.exceptions.map((e) => e.status), ["dangling"], build.name);
      assert.equal(res.record?.summary.cleanup.danglingExceptions, 1, build.name);
    }
  });

  it("refuses a riding record the loader cannot read, as a config defect alone", () => {
    const r = combinedOnHost();
    r.write(".pocket-zipper/exceptions.yml", MALFORMED_REGISTRY);
    r.write("app.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = check(r);
    // The union reads the head registry's records, and a file that cannot be
    // read has no records to offer. The defect is reported alone: it can never
    // share `errors[]` with a `POLICY_CHANGE` the run is not entitled to make.
    assert.equal(res.status, 2);
    assert.deepEqual([...new Set(codes(res.record))], ["CONFIG_ERROR"]);
  });
});

/** A config the contradiction is read from: a baseline carrying exactly this. */
function withBaselineConfig(config: string): FixtureRepo {
  const r = repo();
  r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
  r.write(".pocket-zipper/config.yml", config);
  r.write("app.js", "export const a = 1;\n");
  r.commit("base");
  r.branch("base");
  return r;
}

/**
 * The three facts the contradiction's own diagnostic has to carry: which key
 * is wrong, which values would make the config consistent, and what the repo
 * is left running. Spelled once so the four cases below assert the same
 * contract rather than four different sentences.
 */
function assertContradiction(message: string): void {
  assert.match(message, /'allowSameChangeExceptions'/);
  assert.match(message, /'host'/);
  assert.match(message, /github/);
  assert.match(message, /gitlab-premium/);
  assert.match(message, /two-step/);
}

describe("the combined-landing pair in the config", () => {
  it("refuses the opt-in on every host that cannot guarantee a distinct path approval", () => {
    for (const host of ["gitlab-free", "bitbucket-cloud", "bitbucket-server"]) {
      const res = check(withBaselineConfig(configYaml({ allowSameChangeExceptions: true, host })));
      // Combined landing substitutes the host's path-scoped approval for the
      // second PR. On a host that has no such layer the substitution is a
      // fail-open, so the config is self-contradicting and the repo is forced
      // back to two-step rather than silently trusted.
      assert.equal(res.status, 2, host);
      assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR", host);
      assertContradiction(res.record?.errors[0]?.message ?? "");
    }
  });

  it("refuses the opt-in with no host declared at all", () => {
    const res = check(withBaselineConfig(configYaml({ allowSameChangeExceptions: true })));
    // The other half of the same contradiction: an opt-in with nothing to
    // attest to. A missing key is not a host that can guarantee anything.
    assert.equal(res.status, 2);
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
    assertContradiction(res.record?.errors[0]?.message ?? "");
  });

  it("accepts the opt-in on each host that can guarantee a distinct path approval", () => {
    for (const host of ["github", "gitlab-premium"]) {
      const res = check(withBaselineConfig(configYaml({ allowSameChangeExceptions: true, host })));
      // The positive half, so the refusal above cannot pass with a rule that
      // rejects every combination.
      assert.equal(res.status, 0, host);
      assert.deepEqual(res.record?.errors, [], host);
    }
  });

  it("accepts a host declared without the opt-in, on any host", () => {
    for (const host of ["github", "gitlab-free", "bitbucket-server"]) {
      const res = check(withBaselineConfig(configYaml({ host })));
      // A forward declaration: a repo may attest to its host before it opts in,
      // and a non-guaranteeing host is the truth about that repo, not a defect.
      assert.equal(res.status, 0, host);
      assert.deepEqual(res.record?.errors, [], host);
    }
  });

  it("refuses the contradiction with the gate off, so a dormant config cannot lie", () => {
    const res = check(
      withBaselineConfig(
        configYaml({ enabled: false, allowSameChangeExceptions: true, host: "bitbucket-cloud" }),
      ),
    );
    // Structural checks run even when `enabled: false`: a contradiction that
    // only surfaced at the flip-on would fail an innocent PR.
    assert.equal(res.status, 2);
    assert.equal(res.record?.verdict, "fail");
    assert.equal(res.record?.errors[0]?.code, "CONFIG_ERROR");
    assertContradiction(res.record?.errors[0]?.message ?? "");
  });

  it("does not evaluate the head's contradiction, which bites only once it is the baseline", () => {
    const r = twoStep();
    r.write(
      ".pocket-zipper/config.yml",
      configYaml({ enabled: true, allowSameChangeExceptions: true, host: "bitbucket-cloud" }),
    );
    rideAdditiveRecord(r);
    r.commit("head");
    const res = check(r);
    // A deliberate asymmetry, and the reason a strict head parse is not added:
    // this change is a protected policy change, and a strict head read would
    // turn every typo in a head config into exit 2. The contradiction is caught
    // at the moment it becomes effective, which is the moment it can hurt.
    assert.equal(res.status, 1);
    assert.equal(policyChangeMessage(res.record), `${CONSUMED}${ADDITIVE_CLAUSE}`);
  });

  it("names the key, the required values, and the consequence in the contradiction's own diagnostic", () => {
    // The same check, at the seam that owns the message, so a `CONFIG_ERROR`
    // that named the key and nothing else could not pass.
    assert.throws(
      () =>
        parsePolicy(
          configYaml({ allowSameChangeExceptions: true, host: "bitbucket-cloud" }),
          KNOWN,
        ),
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, "CONFIG_ERROR");
        assertContradiction(e.message ?? "");
        return true;
      },
    );
  });
});

describe("a record re-pointed across files", () => {
  it("reads a re-point across files as an identity edit, on a two-step baseline", () => {
    // `file` is part of the match, so moving a record to a new file is the
    // same debt at a new path — an identity edit, not a fresh grant. Judged on
    // a two-step baseline, where the same-change exception is not in play at
    // all, so this pins the delta's shape and nothing else.
    const r = twoStep({
      app: `export const a = 1;\n${disabled}console.log(1);\n`,
      registry: record({ type: "permanent" }),
    });
    r.git(["mv", "app.js", "lib.js"]);
    r.write("lib.js", `export const a = 1;\n${disabled}console.log(1);\n${noDebugger}debugger;\n`);
    r.write(
      ".pocket-zipper/exceptions.yml",
      record({ type: "permanent", file: "lib.js" }) +
        record({ rule: "no-debugger", fingerprint: NEXT_LINE_NO_DEBUGGER_FP, file: "lib.js", type: "permanent" }),
    );
    r.commit("head");
    const res = check(r);
    // The rename plus a brand-new directive in the new file: today the re-point
    // reads additive, and an exception reading `additive` would let the renewal
    // this same change can carry ride through in one PR.
    assert.equal(res.status, 1);
    assert.equal(policyChangeMessage(res.record), `${CONSUMED}${EDIT_CLAUSE}`);
    assert.deepEqual(res.record?.summary.newDebt, { authorized: 0, unauthorized: 1 });
  });

  it("still reads a twin in a different file as an addition, so combined landing covers it", () => {
    const r = combinedOnHost({ registry: record() });
    // The baseline's slot was *kept*, so there is nothing unmatched for a new
    // slot to claim: this is a genuine new authorization, and a pairing that
    // reached across files too eagerly would read it as an edit and refuse a
    // change that widened nothing.
    r.write(
      ".pocket-zipper/exceptions.yml",
      record() + record({ file: "lib.js" }),
    );
    r.write("lib.js", `export const a = 1;\n${disabled}console.log(1);\n`);
    r.commit("head");
    const res = check(r);
    assert.equal(res.status, 0);
    assert.deepEqual(res.record?.errors, []);
    assert.deepEqual(res.record?.summary.newDebt, { authorized: 1, unauthorized: 0 });
  });
});
