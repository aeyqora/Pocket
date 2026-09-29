import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { editFields } from "../src/registry-edit.js";
import { loadRegistry } from "../src/validate.js";

const FP_A = `v1:sha256:${"a".repeat(64)}`;
const FP_B = `v1:sha256:${"b".repeat(64)}`;

/** A two-record registry, each record carrying a `line` the renewal must not disturb. */
function registry(): string {
  return [
    "# exceptions live here — reviewed by the platform team",
    "- rule: no-console",
    "  suppression_type: next-line",
    `  fingerprint: ${FP_A}`,
    "  file: app.js",
    "  type: temporary",
    "  reason: needed for the debug toolbar",
    '  reference: "#12"',
    "  expires: 2026-10-01",
    "  line: 2",
    "- rule: no-debugger",
    "  suppression_type: block",
    `  fingerprint: ${FP_B}`,
    "  file: tools/build.js",
    "  type: temporary",
    "  reason: needed while the build is instrumented",
    "  expires: 2026-11-01",
    "",
  ].join("\n");
}

describe("the renewal's in-place edit", () => {
  it("edits one record's date and leaves every other byte alone", () => {
    const edited = editFields(registry(), 1, [{ field: "expires", value: "2027-01-15" }]);
    assert.equal(
      edited,
      registry().replace("  expires: 2026-10-01\n", "  expires: 2027-01-15\n"),
    );
  });

  it("edits the second record without disturbing the first", () => {
    const edited = editFields(registry(), 2, [{ field: "expires", value: "2026-12-01" }]);
    assert.equal(
      edited,
      registry().replace("  expires: 2026-11-01\n", "  expires: 2026-12-01\n"),
    );
    assert.ok(edited!.includes("  expires: 2026-10-01\n"));
  });

  it("keeps a trailing comment on the line it edits", () => {
    const raw = registry().replace(
      "  expires: 2026-10-01\n",
      "  expires: 2026-10-01  # quarterly review\n",
    );
    const edited = editFields(raw, 1, [{ field: "expires", value: "2027-01-15" }]);
    assert.equal(
      edited,
      raw.replace("2026-10-01  # quarterly review", "2027-01-15  # quarterly review"),
    );
  });

  it("applies two fields of one record from one parse", () => {
    // The permanent renewal: `type` rewritten and `expires` gone, with no blank
    // line left where the date was.
    const edited = editFields(registry(), 1, [
      { field: "type", value: "permanent" },
      { field: "expires", value: null },
    ]);
    assert.equal(
      edited,
      [
        "# exceptions live here — reviewed by the platform team",
        "- rule: no-console",
        "  suppression_type: next-line",
        `  fingerprint: ${FP_A}`,
        "  file: app.js",
        "  type: permanent",
        "  reason: needed for the debug toolbar",
        '  reference: "#12"',
        "  line: 2",
        "- rule: no-debugger",
        "  suppression_type: block",
        `  fingerprint: ${FP_B}`,
        "  file: tools/build.js",
        "  type: temporary",
        "  reason: needed while the build is instrumented",
        "  expires: 2026-11-01",
        "",
      ].join("\n"),
    );
  });

  it("produces a registry the shared validator still blesses", () => {
    const edited = editFields(registry(), 2, [{ field: "expires", value: "2026-12-01" }])!;
    const records = loadRegistry(edited);
    assert.equal(records.length, 2);
    assert.equal(records[0]!.expires, "2026-10-01");
    assert.equal(records[1]!.expires, "2026-12-01");
    assert.equal(records[1]!.reason, "needed while the build is instrumented");
  });

  it("refuses rather than half-applying an edit it cannot place", () => {
    // An undeclared field, an entry that is not there, a document that is not a
    // list: each is refused whole, so no renewal lands half-written.
    assert.equal(editFields(registry(), 1, [{ field: "owner", value: "team" }]), null);
    assert.equal(editFields(registry(), 3, [{ field: "expires", value: "2027-01-15" }]), null);
    assert.equal(editFields("exceptions: []\n", 1, [{ field: "expires", value: "x" }]), null);
  });
});
