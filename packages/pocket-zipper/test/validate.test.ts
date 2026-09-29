import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { configYaml, createRepo, eslintConfig, exceptionYaml, NEXT_LINE_NO_CONSOLE_FP, NEXT_LINE_NO_DEBUGGER_FP, type FixtureRepo } from "./harness.js";
import { addDuration } from "../src/policy.js";
import { defectsOf, renderFinding, type Finding } from "../src/finding.js";
import { errorRecords, loadRegistry, recordHygiene, statusHygiene, validateRegistry, type HygieneContext } from "../src/validate.js";

import { PocketZipperError } from "../src/errors.js";
import type { ExceptionRecord, ExceptionStatus } from "../src/types.js";

/**
 * The two protected files' constants, spelled here rather than imported so a
 * rename in the source shows up as a changed expectation instead of a
 * silently-changed constant.
 */
const REGISTRY = ".pocket-zipper/exceptions.yml";
const CONFIG = ".pocket-zipper/config.yml";

const FP = `v1:sha256:${"a".repeat(64)}`;
const FP_OTHER = `v1:sha256:${"b".repeat(64)}`;

/**
 * A well-formed entry, one field per line, so a finding's line is countable.
 * An override of `""` drops the field; a `line` override is appended last,
 * because `line` is the one field after `expires` in canonical order.
 */
function entryLines(overrides: Record<string, string> = {}): string[] {
  const fields: Array<[string, string]> = [
    ["rule", "no-console"],
    ["suppression_type", "next-line"],
    ["fingerprint", FP],
    ["file", "app.js"],
    ["type", "temporary"],
    ["reason", "needed"],
    ["reference", `"#1"`],
    ["expires", "2026-12-01"],
    ["line", ""],
  ];
  return fields.flatMap(([key, fallback]) => {
    const value = key in overrides ? overrides[key]! : fallback;
    if (value === "") return [];
    return [`  ${key}: ${value}`];
  }).map((line, index) => (index === 0 ? `- ${line.slice(2)}` : line));
}

/** A well-formed entry plus one bare key, e.g. a field written with nothing after it. */
function withBareKey(lines: string[], key: string): string[] {
  return [...lines, `  ${key}:`];
}

/**
 * The record's own line span and text: what a delete-ready pointer names, and
 * what it shows the maintainer before they cut. Measured from the source, so a
 * block-scalar reason and a comment between records both come out right.
 */
describe("a registry entry's own extent", () => {
  const ONE = registry(entryLines());

  it("ranges the list marker through the last field, and no further", () => {
    // `registryLines` are lines in the *registry* — where the record is. The
    // record's own `line` field is a different number in a different file: it
    // names the suppression, in the source. The two never agree and never
    // substitute for each other.
    const { entries } = validateRegistry(ONE);
    assert.deepEqual(entries[0]?.registryLines, { start: 1, end: 8 });
  });

  it("carries the record's text exactly as written", () => {
    const { entries } = validateRegistry(ONE);
    assert.equal(entries[0]?.text, ONE.trimEnd());
  });

  it("counts a folded scalar's continuation lines as part of the record", () => {
    // A three-line reason is three lines of the record: a span that stopped at
    // the `reason:` key would tell a maintainer to leave half a record behind.
    const folded = registry([
      "- rule: no-console",
      "  suppression_type: next-line",
      `  fingerprint: ${FP}`,
      "  file: app.js",
      "  type: temporary",
      "  reason: >",
      "    the first line",
      "    and the second",
      "  reference: \"#1\"",
      "  expires: 2026-12-01",
    ]);
    const { entries, findings } = validateRegistry(folded);
    assert.deepEqual(findings, []);
    assert.deepEqual(entries[0]?.registryLines, { start: 1, end: 10 });
    assert.match(entries[0]!.text, / {4}and the second/);
  });

  it("gives each entry its own range, so a pointer names one record's lines", () => {
    const two = registry(entryLines(), ["# a comment between records", ...entryLines({ fingerprint: FP_OTHER })]);
    const { entries } = validateRegistry(two);
    // The comment belongs to neither record, and the second entry starts after
    // it — so the first entry's span stops before the comment.
    assert.deepEqual(entries[0]?.registryLines, { start: 1, end: 8 });
    assert.deepEqual(entries[1]?.registryLines, { start: 10, end: 17 });
    assert.doesNotMatch(entries[0]!.text, /a comment between records/);
  });
});

function registry(...entries: string[][]): string {
  return entries.map((lines) => lines.join("\n")).join("\n") + "\n";
}

const VALID = registry(entryLines());

/** The one finding, asserted to be the only one. */
function only(raw: string): Finding {
  const { findings } = validateRegistry(raw);
  assert.equal(findings.length, 1, `expected one finding, got ${JSON.stringify(findings, null, 1)}`);
  return findings[0]!;
}

const NOW = new Date("2026-09-14T12:00:00Z");

function hygiene(overrides: Partial<HygieneContext> = {}): HygieneContext {
  return {
    now: NOW,
    maxExpiry: "3mo",
    knownRules: new Set(["no-console"]),
    liveLines: new Map(),
    ...overrides,
  };
}

describe("validate: defect findings", () => {
  it("accepts an absent, empty, or well-formed registry without a finding", () => {
    for (const raw of [null, "", "# nothing yet\n", VALID]) {
      assert.deepEqual(validateRegistry(raw).findings, [], String(raw));
    }
  });

  it("reports malformed YAML as one defect carrying the parser's position", () => {
    const finding = only("- rule: [unclosed\n");
    assert.equal(finding.code, "MALFORMED");
    assert.equal(finding.severity, "defect");
    assert.equal(finding.path, REGISTRY);
    assert.equal(finding.entry, null);
    assert.equal(finding.line, 2);
    assert.equal(finding.expected, "a well-formed YAML document");
    assert.equal(finding.actual, "YAML the parser rejects");
    // The parser's own `at line L, column C:` tail is dropped: the finding
    // already carries the position, and a clause ending in a colon reads as a
    // message the tool failed to finish.
    assert.doesNotMatch(finding.message, /at line \d+, column \d+:$/);
    assert.ok(finding.message.length > 0);
  });

  it("names a top-level `exceptions:` header and says what to write instead", () => {
    const finding = only("exceptions:\n  - rule: no-console\n");
    assert.equal(finding.code, "MALFORMED");
    assert.equal(finding.field, "exceptions");
    assert.equal(finding.line, 1);
    assert.equal(
      finding.message,
      "entries must be a top-level list, not nested under an `exceptions:` header",
    );
    assert.equal(finding.expected, "a top-level list of records");
    assert.equal(finding.actual, "a mapping with the key 'exceptions'");
  });

  it("names the expected shape where a list entry belongs but a mapping does not", () => {
    const finding = only(registry(entryLines(), ["- just-a-string"]));
    assert.equal(finding.code, "MALFORMED");
    assert.equal(finding.entry, 2);
    assert.equal(finding.line, 9);
    assert.equal(finding.column, 3);
    assert.equal(finding.message, "a registry entry is not a mapping of record fields");
    assert.equal(
      finding.expected,
      "a mapping of record fields (rule, suppression_type, fingerprint, file, type, reason, reference, expires, line)",
    );
    assert.equal(finding.actual, 'the string "just-a-string"');
  });

  it("reports a stale `owner` as an unknown field with the fix attached", () => {
    const finding = only(registry([...entryLines(), "  owner: '@team'"]));
    assert.equal(finding.code, "UNKNOWN_FIELD");
    assert.equal(finding.severity, "defect");
    assert.equal(finding.entry, 1);
    assert.equal(finding.field, "owner");
    assert.equal(finding.line, 9);
    assert.equal(finding.column, 3);
    assert.equal(
      finding.message,
      "unknown field 'owner' — removed from the registry format; delete this line",
    );
  });

  it("reports any other unknown field against the known set", () => {
    const finding = only(registry([...entryLines(), "  ticket: '#2'"]));
    assert.equal(finding.code, "UNKNOWN_FIELD");
    assert.equal(finding.field, "ticket");
    assert.match(finding.message, /^unknown field 'ticket' — known fields are rule, suppression_type/);
  });

  it("reports a missing required field against the entry, not a line that is not there", () => {
    const finding = only(registry(entryLines({ reason: "" })));
    assert.equal(finding.code, "MISSING_FIELD");
    assert.equal(finding.field, "reason");
    assert.equal(finding.line, 1);
    assert.equal(finding.column, 3);
    assert.equal(finding.message, "'reason' is required");
    assert.equal(finding.expected, "a non-empty string");
  });

  it("reports a required field written as a non-string", () => {
    const finding = only(registry(entryLines({ reason: "[a, b]" })));
    assert.equal(finding.code, "MALFORMED");
    assert.equal(finding.field, "reason");
    assert.equal(finding.actual, "a list");
  });

  it("reports an enum violation with the permitted set and the value as written", () => {
    const finding = only(registry(entryLines({ type: "eternal" })));
    assert.equal(finding.code, "INVALID_ENUM");
    assert.equal(finding.field, "type");
    assert.equal(finding.line, 5);
    assert.equal(finding.message, "'type' is not one of 'temporary', 'permanent'");
    assert.equal(finding.expected, "one of temporary, permanent");
    assert.equal(finding.actual, "eternal");
  });

  it("explains why `config-off` is refused rather than listing the enum", () => {
    const finding = only(registry(entryLines({ suppression_type: "config-off" })));
    assert.equal(finding.code, "INVALID_ENUM");
    assert.equal(finding.field, "suppression_type");
    assert.equal(
      finding.message,
      "'suppression_type' cannot be 'config-off' — a config-level suppression is a policy change, not exceptable debt",
    );
  });

  it("requires `expires` on a temporary and refuses it on a permanent", () => {
    const missing = only(registry(entryLines({ expires: "" })));
    assert.equal(missing.code, "MISSING_FIELD");
    assert.equal(missing.field, "expires");
    assert.equal(missing.message, "'expires' is required when 'type' is temporary");

    const forbidden = only(registry(entryLines({ type: "permanent" })));
    assert.equal(forbidden.code, "INVALID_ENUM");
    assert.equal(forbidden.field, "expires");
    assert.equal(forbidden.message, "'expires' must not be declared when 'type' is permanent");
  });

  it("checks the fingerprint grammar, not just its presence", () => {
    const bad = [
      "v1:fp:no-console",
      `v1:sha256:${"A".repeat(64)}`,
      `sha256:${"a".repeat(64)}`,
      `v1:sha256:${"a".repeat(63)}`,
    ];
    for (const fingerprint of bad) {
      const finding = only(registry(entryLines({ fingerprint })));
      assert.equal(finding.code, "FINGERPRINT_FORMAT", fingerprint);
      assert.equal(finding.field, "fingerprint");
      assert.equal(finding.line, 3);
      assert.equal(finding.expected, "v1:sha256:<64 lowercase hex digits>");
      assert.equal(finding.actual, fingerprint);
    }
  });

  it("rejects a date that is well-formed but does not exist", () => {
    const calendar = only(registry(entryLines({ expires: "2026-02-30" })));
    assert.equal(calendar.code, "INVALID_DATE");
    assert.equal(calendar.field, "expires");
    assert.equal(calendar.message, "'expires' is not a real calendar date");
    assert.equal(calendar.actual, "2026-02-30");

    const form = only(registry(entryLines({ expires: "30-12-2026" })));
    assert.equal(form.code, "INVALID_DATE");
    assert.equal(form.message, "'expires' is not a date in YYYY-MM-DD form");
    assert.equal(form.actual, "30-12-2026");
  });

  it("reads a written `expires` as a declaration, even with nothing after it", () => {
    // A bare `expires:` is a permanent record's forbidden field and a temporary
    // record's missing date — not a third thing both quietly accept, which
    // would leave a temporary record with no expiry at all.
    const permanent = only(registry(withBareKey(entryLines({ type: "permanent", expires: "" }), "expires")));
    assert.equal(permanent.code, "INVALID_ENUM");
    assert.equal(permanent.field, "expires");
    assert.equal(permanent.message, "'expires' must not be declared when 'type' is permanent");

    const temporary = only(registry(withBareKey(entryLines({ expires: "" }), "expires")));
    assert.equal(temporary.code, "INVALID_DATE");
    assert.equal(temporary.field, "expires");
    assert.equal(temporary.message, "'expires' is not a date in YYYY-MM-DD form");
    assert.equal(temporary.actual, "an empty value");
  });

  it("accepts a real leap day", () => {
    assert.deepEqual(validateRegistry(registry(entryLines({ expires: "2024-02-29" }))).findings, []);
  });

  it("reads an optional integer `line` and leaves it out of the record when absent", () => {
    assert.equal(loadRegistry(registry(entryLines({ line: "7" })))[0]?.line, 7);
    assert.equal(loadRegistry(VALID)[0]?.line, undefined);
    assert.equal("line" in loadRegistry(VALID)[0]!, false);
  });

  it("rejects a `line` that is not an integer of at least 1", () => {
    for (const bad of ["0", "-3", "2.5", "abc"]) {
      const finding = only(registry(entryLines({ line: bad })));
      assert.equal(finding.code, "MALFORMED", bad);
      assert.equal(finding.field, "line");
      assert.equal(finding.message, "'line' must be an integer of at least 1");
    }
  });

  it("names every defect in the document, and never classifies a defective record", () => {
    const { entries, findings } = validateRegistry(
      registry(entryLines(), entryLines({ fingerprint: "nope", type: "eternal" })),
    );
    // Canonical field order, not document order: `fingerprint` is checked where
    // it sits in the format, so a reader scanning the report reads the record's
    // fields top to bottom.
    assert.deepEqual(
      findings.map((f) => `${f.entry}·${f.field}`),
      ["2·fingerprint", "2·type"],
    );
    // Entry 1 is sound; entry 2 yielded no record to classify.
    assert.deepEqual(entries.map((e) => e.index), [1]);
  });

  it("keeps the entry index and field position addressable", () => {
    const { entries } = validateRegistry(registry(entryLines(), entryLines({ rule: "no-debugger" })));
    assert.deepEqual(entries.map((e) => e.index), [1, 2]);
    assert.equal(entries[0]?.position.line, 1);
    // Entry 2 starts at line 9, so its `reason` is the sixth line of the entry.
    assert.equal(entries[1]?.fields.get("reason")?.line, 14);
    assert.equal(entries[1]?.fields.get("reason")?.column, 3);
  });
});

describe("validate: hygiene findings", () => {
  it("names a rule ESLint does not know here", () => {
    const { entries } = validateRegistry(registry(entryLines({ rule: "no-such-rule" })));
    const findings = recordHygiene(entries, hygiene());
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assert.equal(finding.code, "UNKNOWN_RULE");
    assert.equal(finding.severity, "hygiene");
    assert.equal(finding.field, "rule");
    assert.equal(finding.line, 1);
    assert.equal(finding.actual, "no-such-rule");
  });

  it("skips the referential check when the known set is empty", () => {
    const { entries } = validateRegistry(registry(entryLines({ rule: "no-such-rule" })));
    assert.deepEqual(recordHygiene(entries, hygiene({ knownRules: new Set() })), []);
  });

  it("reports a temporary running past the policy's maximum, relative to today", () => {
    const { entries } = validateRegistry(registry(entryLines({ expires: "2027-09-14" })));
    const findings = recordHygiene(entries, hygiene());
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assert.equal(finding.code, "OVERLONG_EXCEPTION");
    assert.equal(finding.field, "expires");
    assert.equal(finding.line, 8);
    assert.equal(finding.message, "'expires' runs past the policy's 3mo maximum");
    assert.equal(finding.expected, "on or before 2026-12-14 (3mo from today)");
  });

  it("adds a stale `line` as orientation, never as its own finding", () => {
    const { entries } = validateRegistry(registry(entryLines({ expires: "2027-09-14", line: "3" })));
    const ctx = hygiene({ liveLines: new Map([[entries[0]!.record, 41]]) });
    const findings = recordHygiene(entries, ctx);
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.message, /\(record says 3, currently at 41\)$/);
  });

  it("maps each non-used status to its own code, and reports nothing for a used one", () => {
    const { entries } = validateRegistry(registry(entryLines(), entryLines({ fingerprint: FP_OTHER })));
    const statuses = new Map<ExceptionRecord, ExceptionStatus>([
      [entries[0]!.record, "dangling"],
      [entries[1]!.record, "used"],
    ]);
    const findings = statusHygiene(entries, statuses, hygiene());
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.code, "DANGLING_EXCEPTION");
    assert.equal(findings[0]!.entry, 1);
    assert.equal(findings[0]!.severity, "hygiene");
  });

  it("names spent and expired distinctly, and reports an expired record's date", () => {
    const { entries } = validateRegistry(registry(entryLines(), entryLines({ expires: "2000-01-01" })));
    const spent = statusHygiene(
      entries,
      new Map<ExceptionRecord, ExceptionStatus>([
        [entries[0]!.record, "spent"],
        [entries[1]!.record, "expired"],
      ]),
      hygiene(),
    );
    assert.deepEqual(spent.map((f) => f.code), ["SPENT_EXCEPTION", "EXPIRED_EXCEPTION"]);
    assert.equal(spent[1]!.message, "expired 2000-01-01; the record authorizes nothing");
  });

  it("points a dangling record at the line it last knew", () => {
    const { entries } = validateRegistry(registry(entryLines({ line: "9" })));
    const findings = statusHygiene(
      entries,
      new Map<ExceptionRecord, ExceptionStatus>([[entries[0]!.record, "dangling"]]),
      hygiene(),
    );
    assert.equal(findings[0]!.message, "no suppression matches this record in app.js (last known: line 9)");
  });
});

describe("validate: the failing read", () => {
  it("reports one `errors[]` entry per defect, each the shared diagnostic line", () => {
    const raw = registry(entryLines(), [...entryLines({ fingerprint: "nope" }), "  owner: '@team'"]);
    let thrown: PocketZipperError | null = null;
    try {
      loadRegistry(raw);
    } catch (err) {
      thrown = err as PocketZipperError;
    }
    assert.ok(thrown, "expected a defect");
    assert.equal(thrown.code, "CONFIG_ERROR");
    const records = errorRecords(thrown);
    assert.deepEqual(records.map((r) => r.code), ["CONFIG_ERROR", "CONFIG_ERROR"]);
    assert.match(records[0]!.message, /FINGERPRINT_FORMAT {2}entry 2 · fingerprint/);
    assert.match(records[1]!.message, /UNKNOWN_FIELD {2}entry 2 · owner/);
    // The thrown message is the same lines joined, so a caller reporting the
    // error whole reads the same as one reading `errors[]`.
    assert.equal(thrown.message, records.map((r) => r.message).join("\n"));
  });

  it("leaves any other error as itself", () => {
    const other = new PocketZipperError("INTERNAL_ERROR", "boom", { some: "detail" });
    assert.deepEqual(errorRecords(other), [
      { code: "INTERNAL_ERROR", message: "boom", detail: { some: "detail" } },
    ]);
  });

  it("renders one greppable diagnostic line per finding", () => {
    assert.equal(
      renderFinding({
        code: "UNKNOWN_FIELD",
        severity: "defect",
        path: REGISTRY,
        entry: 2,
        field: "owner",
        line: 9,
        column: 3,
        message: "unknown field 'owner' — removed from the registry format; delete this line",
      }),
      `${REGISTRY}:9:3  UNKNOWN_FIELD  entry 2 · owner  unknown field 'owner' — removed from the registry format; delete this line`,
    );
    assert.equal(
      renderFinding({
        code: "DANGLING_EXCEPTION",
        severity: "hygiene",
        path: REGISTRY,
        entry: 1,
        field: null,
        line: 1,
        column: 3,
        message: "no suppression matches this record in app.js",
      }),
      `${REGISTRY}:1:3  DANGLING_EXCEPTION  entry 1  no suppression matches this record in app.js`,
    );
  });

  it("separates the two tiers without a third", () => {
    const defects = validateRegistry(registry(entryLines({ type: "eternal" }))).findings;
    const { entries } = validateRegistry(VALID);
    const hygieneFindings = statusHygiene(
      entries,
      new Map<ExceptionRecord, ExceptionStatus>([[entries[0]!.record, "dangling"]]),
      hygiene(),
    );
    const all = [...defects, ...hygieneFindings];
    assert.deepEqual(defectsOf(all).map((f) => f.severity), ["defect"]);
    assert.deepEqual(defectsOf(hygieneFindings), []);
  });
});

// --- the command, through the CLI fixture seam ----------------------------

/** Today, and the dates this repo's own policy is judged against. */
const TODAY = new Date().toISOString().slice(0, 10);
const IN_WINDOW = addDuration(TODAY, "30d");
const BEYOND_HORIZON = addDuration(TODAY, "6mo");
const LONG_PAST = "2000-01-01";

describe("pocket-zipper validate through the CLI fixture seam", () => {
  const repos: FixtureRepo[] = [];
  after(() => repos.forEach((r) => r.cleanup()));

  /** A repo with a real ESLint config, a real suppression, and no registry yet. */
  function repo(): FixtureRepo {
    const r = createRepo();
    repos.push(r);
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error", "no-debugger": "error" }));
    r.write("app.js", '// eslint-disable-next-line no-console\nconsole.log("hi");\n');
    r.write(CONFIG, "enabled: true\nexceptions:\n  defaultExpiry: 30d\n  maxExpiry: 3mo\n");
    return r;
  }

  /**
   * `validate`'s own exit code and output lines, with no JSON record asked for.
   * The report is the findings followed, when there are unused records, by the
   * delete-ready cleanup pointers — so `findings` pulls the diagnostic lines back
   * out for the tests that pin the finding set exactly and have no business also
   * pinning the pointers.
   */
  function validate(r: FixtureRepo): { status: number; lines: string[] } {
    const res = r.runCli(["validate"], { json: false });
    return { status: res.status, lines: res.stdout.trimEnd().split("\n") };
  }

  /** The report's diagnostic lines, without the cleanup pointers beneath them. */
  function findingsOf(res: { lines: string[] }): string[] {
    return res.lines.filter(
      (line) => line.startsWith(`${REGISTRY}:`) || line.startsWith(`${CONFIG}:`),
    );
  }

  it("passes a repository that governs nothing", () => {
    const r = createRepo();
    repos.push(r);
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    assert.deepEqual(validate(r), {
      status: 0,
      lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
    });
  });

  it("passes a valid registry with every finding absent", () => {
    const r = repo();
    r.write(
      REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: IN_WINDOW,
        line: 1,
      }),
    );
    assert.deepEqual(validate(r), {
      status: 0,
      lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
    });
  });

  it("reports every defect, names the line, and exits 2", () => {
    const r = repo();
    r.write(
      REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: IN_WINDOW,
      }) +
        "  owner: '@team'\n" +
        exceptionYaml({
          rule: "no-debugger",
          suppressionType: "next-line",
          fingerprint: "v1:fp:no-console",
          file: "app.js",
          expires: "2026-02-30",
        }),
    );
    const { status, lines } = validate(r);
    assert.equal(status, 2);
    assert.equal(lines[0], "pocket-zipper: INVALID (3 defects, 0 hygiene findings)");
    assert.deepEqual(lines.slice(2), [
      `${REGISTRY}:9:3  UNKNOWN_FIELD  entry 1 · owner  unknown field 'owner' — removed from the registry format; delete this line`,
      `${REGISTRY}:12:3  FINGERPRINT_FORMAT  entry 2 · fingerprint  'fingerprint' is not a valid fingerprint — expected v1:sha256:<64 lowercase hex digits>, got v1:fp:no-console`,
      `${REGISTRY}:17:3  INVALID_DATE  entry 2 · expires  'expires' is not a real calendar date — expected a real date in YYYY-MM-DD form, got 2026-02-30`,
    ]);
  });

  it("reports a missing field and an enum violation in the same report", () => {
    const r = repo();
    r.write(
      REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: IN_WINDOW,
      }).replace("  reason: needed\n", "") +
        exceptionYaml({
          rule: "no-debugger",
          suppressionType: "next-line",
          fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
          file: "app.js",
          expires: IN_WINDOW,
        }).replace("  type: temporary\n", "  type: eternal\n"),
    );
    const { status, lines } = validate(r);
    assert.equal(status, 2);
    assert.equal(lines[0], "pocket-zipper: INVALID (2 defects, 0 hygiene findings)");
    // An absent field is reported where the entry starts: the author is looking
    // at the record, not at a line that is not there.
    assert.deepEqual(lines.slice(2), [
      `${REGISTRY}:1:3  MISSING_FIELD  entry 1 · reason  'reason' is required — expected a non-empty string`,
      `${REGISTRY}:12:3  INVALID_ENUM  entry 2 · type  'type' is not one of 'temporary', 'permanent' — expected one of temporary, permanent, got eternal`,
    ]);
  });

  it("names the copy/paste classes in the author's own words", () => {
    const header = repo();
    header.write(REGISTRY, "exceptions:\n  - rule: no-console\n");
    assert.deepEqual(validate(header).lines.slice(2), [
      `${REGISTRY}:1:1  MALFORMED  document · exceptions  entries must be a top-level list, not nested under an \`exceptions:\` header — expected a top-level list of records, got a mapping with the key 'exceptions'`,
    ]);
    assert.equal(validate(header).status, 2);

    const shape = repo();
    shape.write(REGISTRY, "- just-a-string\n");
    assert.deepEqual(validate(shape).lines.slice(2), [
      `${REGISTRY}:1:3  MALFORMED  entry 1  a registry entry is not a mapping of record fields — expected a mapping of record fields (rule, suppression_type, fingerprint, file, type, reason, reference, expires, line), got the string "just-a-string"`,
    ]);
    assert.equal(validate(shape).status, 2);
  });

  it("reports a defective config in the same two-tier report", () => {
    const r = repo();
    r.write(CONFIG, "enabled: true\nwhatsthis: 1\n");
    r.write(
      REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: IN_WINDOW,
      }),
    );
    const { status, lines } = validate(r);
    assert.equal(status, 2);
    assert.equal(lines[0], "pocket-zipper: INVALID (1 defect, 0 hygiene findings)");
    // The path is printed once, by the line itself: `parsePolicy` names the file
    // in its own message because that message also travels standalone.
    assert.deepEqual(lines.slice(2), [
      `${CONFIG}  MALFORMED  document  unknown key 'whatsthis'`,
    ]);
  });

  it("names a config that cannot be parsed at all, without repeating the path", () => {
    const r = repo();
    r.write(CONFIG, "enabled: [unclosed\n");
    const { status, lines } = validate(r);
    assert.equal(status, 2);
    assert.deepEqual(lines.slice(2), [
      `${CONFIG}  MALFORMED  document  the policy document is not a well-formed YAML mapping`,
    ]);
  });

  it("calls a protected file it cannot read a defect, not a clean repository", () => {
    const r = repo();
    // A directory where the registry belongs. EISDIR is deterministic where a
    // `chmod 000` is not: a root user reads through the permission bits.
    r.mkdir(REGISTRY);
    const { status, lines } = validate(r);
    assert.equal(status, 2);
    assert.deepEqual(lines.slice(2), [
      `${REGISTRY}  MALFORMED  document  the document could not be read (EISDIR)`,
    ]);
  });

  it("reports every hygiene finding, prints none as an error, and exits 0", () => {
    const r = repo();
    r.write(
      REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: IN_WINDOW,
        line: 1,
      }) +
        exceptionYaml({
          rule: "no-debugger",
          suppressionType: "next-line",
          fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
          file: "app.js",
          expires: IN_WINDOW,
        }) +
        exceptionYaml({
          rule: "no-such-rule",
          suppressionType: "next-line",
          fingerprint: FP_OTHER,
          file: "app.js",
          expires: BEYOND_HORIZON,
        }) +
        exceptionYaml({
          rule: "no-debugger",
          suppressionType: "next-line",
          fingerprint: FP_OTHER,
          file: "app.js",
          expires: LONG_PAST,
        }),
    );
    const res = validate(r);
    assert.equal(res.status, 0);
    // Entry 3 carries two: the rule id is unknown *and* nothing can match a
    // record naming it. Both are true, and neither is a failure.
    assert.equal(res.lines[0], "pocket-zipper: OK (0 defects, 5 hygiene findings)");
    assert.deepEqual(findingsOf(res), [
      `${REGISTRY}:18:3  UNKNOWN_RULE  entry 3 · rule  'rule' names a rule ESLint does not know here — expected a core rule or one a configured plugin contributes, got no-such-rule`,
      `${REGISTRY}:25:3  OVERLONG_EXCEPTION  entry 3 · expires  'expires' runs past the policy's 3mo maximum — expected on or before ${addDuration(TODAY, "3mo")} (3mo from today), got ${BEYOND_HORIZON}`,
      `${REGISTRY}:10:3  DANGLING_EXCEPTION  entry 2  no suppression matches this record in app.js`,
      `${REGISTRY}:18:3  DANGLING_EXCEPTION  entry 3  no suppression matches this record in app.js`,
      `${REGISTRY}:26:3  EXPIRED_EXCEPTION  entry 4  expired ${LONG_PAST}; the record authorizes nothing`,
    ]);
  });

  it("authorizes the first K records sharing a match key and calls the rest dangling", () => {
    const record = (line?: number) =>
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: IN_WINDOW,
        ...(line === undefined ? {} : { line }),
      });
    // One live suppression, two records naming it: allocation is a consuming
    // count, so exactly one record is in use and its sibling is surplus — which
    // is dangling, plus the pool's arithmetic naming the same entry as the one
    // to delete. The count line is the "why"; the status is the detail.
    const one = repo();
    one.write(REGISTRY, record() + record());
    const first = validate(one);
    assert.equal(first.status, 0);
    assert.equal(first.lines[0], "pocket-zipper: OK (0 defects, 2 hygiene findings)");
    assert.deepEqual(findingsOf(first), [
      `${REGISTRY}:9:3  POOL_COUNTS  entry 2  For this rule at this file: 2 matching records, 1 used, 1 leftover`,
      `${REGISTRY}:9:3  DANGLING_EXCEPTION  entry 2  no suppression matches this record in app.js`,
    ]);

    // Two identical directives, two records: both authorizations are real, and
    // each record's stale note names the line it actually landed on. The pool
    // balances, so it has nothing to report and the registry stays clean.
    const two = repo();
    two.write(
      "app.js",
      '// eslint-disable-next-line no-console\nconsole.log("a");\n// eslint-disable-next-line no-console\nconsole.log("b");\n',
    );
    two.write(REGISTRY, record(1) + record(3));
    assert.deepEqual(validate(two), {
      status: 0,
      lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
    });
  });

  it("accuses a leftover record of a renewal only when its date disagrees", () => {
    const record = (expires: string) =>
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires,
      });

    // Two records, one live suppression, the same date on both: a twin pool
    // mid-landing, and nothing but a surplus record. A renewal accusation here
    // would be wrong — nobody renewed anything, and the hygiene count says so.
    const agreeing = repo();
    agreeing.write(REGISTRY, record(IN_WINDOW) + record(IN_WINDOW));
    const same = validate(agreeing);
    assert.equal(same.status, 0);
    assert.equal(same.lines[0], "pocket-zipper: OK (0 defects, 2 hygiene findings)");
    assert.deepEqual(same.lines.filter((line) => line.includes("RENEWAL_BY_APPEND")), []);

    // The same pool with the second record's date moved on: that is the shape a
    // renewal-by-append takes, and it is the surplus record the finding names.
    const disagreeing = repo();
    disagreeing.write(REGISTRY, record(IN_WINDOW) + record(addDuration(TODAY, "31d")));
    const different = validate(disagreeing);
    assert.equal(different.status, 0);
    assert.equal(different.lines[0], "pocket-zipper: OK (0 defects, 3 hygiene findings)");
    const renewal = different.lines.filter((line) => line.includes("RENEWAL_BY_APPEND"));
    assert.equal(renewal.length, 1);
    assert.match(renewal[0]!, / {2}RENEWAL_BY_APPEND {2}entry 2 {2}/);
    assert.match(renewal[0]!, /renewal is an edit of the existing record, not an append/);
  });

  it("never accuses a twin pool of a renewal, even with two different dates", () => {
    const record = (expires: string) =>
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires,
      });
    const r = repo();
    r.write(
      "app.js",
      '// eslint-disable-next-line no-console\nconsole.log("a");\n// eslint-disable-next-line no-console\nconsole.log("b");\n',
    );
    // Two records for two live suppressions, each with its own horizon: the
    // shape a twin pool is *supposed* to have. Every record is used, so there
    // is no leftover to accuse, and two suppressions with two dates is not a
    // renewal — it is two suppressions.
    r.write(REGISTRY, record(IN_WINDOW) + record(addDuration(TODAY, "31d")));
    assert.deepEqual(validate(r), {
      status: 0,
      lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
    });
  });

  it("keeps a well-kept registry at zero hygiene findings, pools and all", () => {
    const r = repo();
    r.write("tools.js", '// eslint-disable-next-line no-debugger\ndebugger;\n');
    r.write(
      REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: IN_WINDOW,
      }) +
        exceptionYaml({
          rule: "no-debugger",
          suppressionType: "next-line",
          fingerprint: NEXT_LINE_NO_DEBUGGER_FP,
          file: "tools.js",
          expires: IN_WINDOW,
        }),
    );
    // Both pools are real and both balance. A registry kept this way stays at
    // zero hygiene findings: the count line has nothing to say, and a well-kept
    // registry must not accumulate findings nobody can act on.
    assert.deepEqual(validate(r), {
      status: 0,
      lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
    });
  });

  it("judges a record unjudged, not dangling, when its file is not in the tree", () => {
    const r = repo();
    r.write(
      REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "not-here.js",
        expires: IN_WINDOW,
      }),
    );
    // An absent file is no evidence about the record; calling it dangling would
    // report the file's absence as the suppression's absence.
    assert.deepEqual(validate(r), {
      status: 0,
      lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
    });
  });

  it("still reports a record expired when the tree could not read its file", () => {
    const r = repo();
    r.write(
      REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "not-here.js",
        expires: LONG_PAST,
      }),
    );
    // Expiry needs no tree: the date is on the record, so an absent file cannot
    // hide it. Excluding the record from allocation is what keeps an unreadable
    // file from reading as dangling; it must not also cost the expiry finding.
    const { status, lines } = validate(r);
    assert.equal(status, 0);
    assert.equal(lines[0], "pocket-zipper: OK (0 defects, 1 hygiene finding)");
    assert.match(lines[2]!, new RegExp(`EXPIRED_EXCEPTION  entry 1  expired ${LONG_PAST}`));
  });

  it("judges nothing, and does not crash, when the tree has no usable ESLint", () => {
    const r = createRepo();
    repos.push(r);
    // No flat config: the ESLint session cannot lint, so no record gets a verdict.
    r.write("app.js", '// eslint-disable-next-line no-console\nconsole.log("hi");\n');
    r.write(
      REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: NEXT_LINE_NO_CONSOLE_FP,
        file: "app.js",
        expires: IN_WINDOW,
      }),
    );
    assert.deepEqual(validate(r), {
      status: 0,
      lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
    });
  });

  it("prints the same diagnostic line the evaluation's baseline load reports", () => {
    const r = repo();
    r.write(
      REGISTRY,
      exceptionYaml({
        rule: "no-console",
        suppressionType: "next-line",
        fingerprint: "v1:fp:no-console",
        file: "app.js",
        expires: IN_WINDOW,
      }),
    );
    r.commit("base");
    r.branch("base");

    const validation = validate(r);
    const check = r.runCli(["check", "--base", "base"]);
    assert.equal(validation.status, 2);
    assert.equal(check.status, 2);
    assert.deepEqual(
      validation.lines.slice(2).map((line) => line.replace(/^.*?  /, "")),
      check.record?.errors.map((e) => e.message.replace(/^.*?  /, "")),
    );
    assert.equal(check.record?.errors[0]?.code, "CONFIG_ERROR");
  });

  it("advertises itself in the usage text, so it is discoverable without a README", () => {
    const res = repos[0]!.runCli(["--help"], { json: false });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^ {2}pocket-zipper validate$/m);
  });

  it("takes no flags at all, and no --strict", () => {
    const r = repo();
    for (const args of [["validate", "--strict"], ["validate", "--json", "out.json"], ["validate", "--verbose"]]) {
      const res = r.runCli(args, { json: false });
      assert.equal(res.status, 2, args.join(" "));
      assert.match(res.stderr, /unknown argument/, args.join(" "));
    }
    assert.deepEqual(validate(r).status, 0);
  });
});

// --- the combined-landing corroborations ----------------------------------

/** The owners file, in the location a GitHub checkout reads it from. */
const OWNERS = ".github/CODEOWNERS";

/** The three remotes a checkout can be classified from, one per known domain. */
const GITHUB_REMOTE = "git@github.com:team/repo.git";
const BITBUCKET_REMOTE = "git@bitbucket.org:team/repo.git";
const GITLAB_REMOTE = "https://gitlab.com/team/repo.git";

/** An owners file that already claims the policy path, so only the host arm can speak. */
const COVERS_POLICY_PATH = ".pocket-zipper/** @repo-owner\n";

/**
 * The two corroborations read *config* for a mismatch: what the config declares
 * against what the checkout actually is. The core never reads approval state, so
 * these are the only in-tool signals a combined repo gets before its distinct
 * path-scoped approval quietly stops existing — and both are hygiene, so neither
 * can fail a run. That last part is asserted in every test here.
 */
describe("validate: the combined-landing corroborations", () => {
  const repos: FixtureRepo[] = [];
  after(() => repos.forEach((r) => r.cleanup()));

  /**
   * A repo shaped like a declaration under test: the config declares, the remote
   * observes, and the owners file is whatever the test says the host would read.
   * Each of the three is opt-out and no other fact is in play, so the count on
   * the verdict line is exactly what the two corroborations contributed.
   */
  function repo(opts: {
    combined?: boolean;
    host?: string;
    remote?: string;
    owners?: string | null;
  } = {}): FixtureRepo {
    const r = createRepo();
    repos.push(r);
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.write(
      CONFIG,
      configYaml({
        enabled: true,
        ...(opts.combined === undefined ? {} : { allowSameChangeExceptions: opts.combined }),
        ...(opts.host === undefined ? {} : { host: opts.host }),
      }),
    );
    // A registry with no records is still a protected file present, which is the
    // precondition both corroborations read — and contributes no finding of its
    // own, so the two arms are the only thing the count can be talking about.
    r.write(REGISTRY, "# nothing yet\n");
    if (opts.owners) r.write(OWNERS, opts.owners);
    if (opts.remote) r.git(["remote", "add", "origin", opts.remote]);
    return r;
  }

  /** `validate`'s own exit code and diagnostic lines, as the block above reads them. */
  function validate(r: FixtureRepo): { status: number; lines: string[] } {
    const res = r.runCli(["validate"], { json: false });
    return { status: res.status, lines: res.stdout.trimEnd().split("\n") };
  }

  /**
   * The diagnostic lines carrying one code. Matching on the code's own greppable
   * token keeps a `path:line:col` prefix and any scope segment free to vary; only
   * the code is the contract.
   */
  function findingsFor(lines: string[], code: string): string[] {
    return lines.filter((line) => line.includes(`  ${code}  `));
  }

  /** The protected file a diagnostic line is about: its first greppable field. */
  function pathOf(line: string): string {
    return line.split("  ")[0]!;
  }

  it("flags a github declaration against a Bitbucket remote, and still exits 0", () => {
    const r = repo({ combined: true, host: "github", remote: BITBUCKET_REMOTE, owners: COVERS_POLICY_PATH });
    const { status, lines } = validate(r);
    // The config check and this corroboration are separate answers: combined on
    // `github` is a *legal* config, and the remote is what says the repo is not
    // on GitHub. Both are true at once, and only the finding says so.
    assert.equal(status, 0);
    assert.equal(lines[0], "pocket-zipper: OK (0 defects, 1 hygiene finding)");
    const [finding] = findingsFor(lines, "HOST_MISMATCH");
    assert.ok(finding, `expected a HOST_MISMATCH line, got ${JSON.stringify(lines)}`);
    assert.ok(finding.startsWith(CONFIG), finding);
    // The line names both sides of the disagreement: a declaration without the
    // thing it disagrees with is not actionable, and one with only the observed
    // host is not greppable by a declared `host: github`.
    assert.match(finding, /github/, finding);
    assert.match(finding, /bitbucket/, finding);
  });

  it("flags a bitbucket declaration against a GitHub remote, so the cross-check is not one-way", () => {
    // `bitbucket-cloud` with the opt-in off is a legal config, and the one every
    // two-step Bitbucket repo runs; a check that only looked for a github
    // declaration would pass it silently.
    const r = repo({ host: "bitbucket-cloud", remote: GITHUB_REMOTE, owners: COVERS_POLICY_PATH });
    const { status, lines } = validate(r);
    assert.equal(status, 0);
    assert.equal(lines[0], "pocket-zipper: OK (0 defects, 1 hygiene finding)");
    const [finding] = findingsFor(lines, "HOST_MISMATCH");
    assert.ok(finding, `expected a HOST_MISMATCH line, got ${JSON.stringify(lines)}`);
    assert.match(finding, /bitbucket/, finding);
    assert.match(finding, /github/, finding);
  });

  it("says nothing when the checkout has no remote to compare against", () => {
    // A `git clone` always has one; a tarball, a vendored dependency, and CI's
    // `actions/checkout` without a `fetch-depth` remote may not. Absent is not
    // disagreeing, and a finding here would train authors to ignore the finding.
    const r = repo({ combined: true, host: "github", owners: COVERS_POLICY_PATH });
    assert.deepEqual(validate(r), {
      status: 0,
      lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
    });
  });

  it("says nothing on a remote it cannot classify, on a custom domain or a self-hosted GitLab", () => {
    for (const remote of [
      "https://git.example.com/team/repo.git",
      "https://gitlab.example.com/team/repo.git",
      "git@mirror.internal:repos/team/repo.git",
    ]) {
      const r = repo({ combined: true, host: "github", remote, owners: COVERS_POLICY_PATH });
      // The docs say warn-only, and say why: custom-domain, self-hosted, mirror
      // and no-remote checkouts are not classifiable from a remote URL. Calling
      // `gitlab.example.com` a mismatch would cry wolf at a repo doing exactly
      // the right thing, which is the one way this finding loses its value.
      assert.deepEqual(validate(r), {
        status: 0,
        lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
      }, remote);
    }
  });

  it("reads a GitLab plan as invisible in the remote, on either plan", () => {
    // The tier is not in a remote URL, so folding it away is forced: an
    // implementation that compared plans would flag every premium repo on
    // `gitlab.com` as a mismatch against itself, and would flag the free tier
    // as agreeing for the wrong reason.
    for (const posture of [
      { host: "gitlab-premium", combined: true },
      { host: "gitlab-free", combined: false },
    ]) {
      const r = repo({ ...posture, remote: GITLAB_REMOTE, owners: COVERS_POLICY_PATH });
      assert.deepEqual(validate(r), {
        status: 0,
        lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
      }, posture.host);
    }
  });

  it("surfaces each protected path that no owners file claims at all", () => {
    const r = repo({ combined: true, host: "github", remote: GITHUB_REMOTE });
    const { status, lines } = validate(r);
    // Two paths, two findings, because a finding is about one file: the config
    // and the registry are approved separately, and a repo owning one of them
    // has exactly the one-gap fail-open this is meant to surface.
    assert.equal(status, 0);
    assert.equal(lines[0], "pocket-zipper: OK (0 defects, 2 hygiene findings)");
    assert.deepEqual(findingsFor(lines, "OWNERS_FILE_READINESS").map(pathOf).sort(), [
      CONFIG,
      REGISTRY,
    ]);
  });

  it("surfaces the policy path when the working tree's owners file claims everything else", () => {
    const r = repo({
      combined: true,
      host: "github",
      remote: GITHUB_REMOTE,
      owners: "# owners\napp.js @repo-owner\n",
    });
    const { status, lines } = validate(r);
    // The ordinary silent fail-open: a repo with real owners, where the policy
    // path was simply never added to them. The owners file being present is
    // therefore not evidence that the path is owned, and the two cases are
    // deliberately not collapsed into one.
    assert.equal(status, 0);
    assert.equal(lines[0], "pocket-zipper: OK (0 defects, 2 hygiene findings)");
    assert.deepEqual(findingsFor(lines, "OWNERS_FILE_READINESS").map(pathOf).sort(), [
      CONFIG,
      REGISTRY,
    ]);
  });

  it("accepts any of the spellings an owners file uses to claim the policy path", () => {
    for (const rule of [
      ".pocket-zipper/** @repo-owner",
      "/.pocket-zipper/** @repo-owner",
      "/.pocket-zipper/ @repo-owner",
      "[Registry]\n.pocket-zipper/ @repo-owner",
    ]) {
      const r = repo({ combined: true, host: "github", remote: GITHUB_REMOTE, owners: `${rule}\n` });
      // CODEOWNERS has four ways to say this, and the example files in
      // `docs/ci/examples/` use all of them. Refusing the ones that plainly do
      // claim the path would push authors to a gitignore engine this tool has
      // no business implementing.
      assert.deepEqual(validate(r), {
        status: 0,
        lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
      }, JSON.stringify(rule));
    }
  });

  it("reports both corroborations in one run, and still exits 0", () => {
    const r = repo({ combined: true, host: "github", remote: BITBUCKET_REMOTE });
    // The whole point of hygiene: a repo that is failing both ways is told so,
    // and the run still passes. Only the host's own branch protection can turn
    // these into a gate, which is exactly why the tool must not exit non-zero.
    const { status, lines } = validate(r);
    assert.equal(status, 0);
    assert.equal(lines[0], "pocket-zipper: OK (0 defects, 3 hygiene findings)");
    assert.equal(findingsFor(lines, "HOST_MISMATCH").length, 1);
    assert.equal(findingsFor(lines, "OWNERS_FILE_READINESS").length, 2);
  });

  it("stays silent on a repository that governs nothing", () => {
    const r = createRepo();
    repos.push(r);
    r.write("eslint.config.mjs", eslintConfig({ "no-console": "error" }));
    r.write("app.js", "export const a = 1;\n");
    r.write(OWNERS, `${COVERS_POLICY_PATH}app.js @repo-owner\n`);
    r.git(["remote", "add", "origin", GITHUB_REMOTE]);
    // Both protected files absent is the short-circuit `runValidate` already
    // takes, and it has to keep taking it: with no config there is no declared
    // host to disagree with anything, and a tool that reported on a repository
    // that governs nothing has nothing to report.
    assert.deepEqual(validate(r), {
      status: 0,
      lines: ["pocket-zipper: OK (0 defects, 0 hygiene findings)"],
    });
  });
});
