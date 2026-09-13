import type { EvaluationRecord, InventoryEntry, RecordError } from "./types.js";

export interface ReportOptions {
  verbose: boolean;
  tty: boolean;
}

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

function color(text: string, code: string, tty: boolean): string {
  return tty ? `${code}${text}${RESET}` : text;
}

export function renderReport(record: EvaluationRecord, options: ReportOptions): string {
  const { verbose, tty } = options;
  const lines: string[] = [];

  if (record.verdict === "excluded") {
    if (record.mode === "check" || verbose) {
      lines.push(color("pocket-lock: EXCLUDED (policy disabled)", YELLOW, tty));
    }
    return joinLines(lines);
  }

  if (record.verdict === "pass") {
    if (record.mode === "check" || verbose) {
      lines.push(color("pocket-lock: PASS", GREEN, tty));
    }
    return joinLines(lines);
  }

  lines.push(color("pocket-lock: FAIL", RED, tty));
  const d = record.summary.dispositions;
  lines.push(
    `  existing: ${d.existing}  moved-existing: ${d.movedExisting}  removed: ${d.removed}  new: ${d.new}  materially-changed: ${d.materiallyChanged}`,
  );

  const flagged = record.inventory.filter(
    (e) =>
      (e.disposition === "new" || e.disposition === "materially-changed") &&
      e.exception === null &&
      e.guardKind === "directive",
  );
  const flaggedConfig = record.inventory.filter(
    (e) =>
      (e.disposition === "new" || e.disposition === "materially-changed") &&
      e.exception === null &&
      e.guardKind === "config-level",
  );
  if (flagged.length > 0) {
    lines.push("");
    lines.push("New suppression debt requiring an exception:");
    for (const entry of flagged) {
      lines.push(...renderProblem(entry));
    }
  }
  if (flaggedConfig.length > 0) {
    lines.push("");
    lines.push("New config-level suppression debt (policy track; not exceptable):");
    for (const entry of flaggedConfig) {
      lines.push(
        `  ${entry.file}:${entry.lines.head ?? "?"}  ${entry.rule}  (${entry.suppressionType})`,
      );
    }
  }

  const authorized = record.inventory.filter(
    (e) =>
      (e.disposition === "new" || e.disposition === "materially-changed") &&
      e.exception !== null,
  );
  if (authorized.length > 0) {
    lines.push("");
    lines.push("New suppression debt authorized by exception:");
    for (const entry of authorized) {
      lines.push(`  ${entry.file}:${entry.lines.head ?? "?"}  ${entry.rule}  (${entry.suppressionType})`);
    }
  }

  const cleanup = record.summary.cleanup;
  if (
    cleanup.danglingExceptions > 0 ||
    cleanup.spentExceptions > 0 ||
    cleanup.expiredExceptions > 0
  ) {
    lines.push("");
    lines.push(
      `Unused exceptions: dangling ${cleanup.danglingExceptions}, spent ${cleanup.spentExceptions}, expired ${cleanup.expiredExceptions}`,
    );
  }

  if (record.errors.length > 0) {
    lines.push("");
    for (const err of record.errors) lines.push(renderError(err));
  }

  return joinLines(lines);
}

function renderProblem(entry: InventoryEntry): string[] {
  const line = entry.lines.head ?? "?";
  const out: string[] = [];
  out.push(
    `  ${color(`${entry.file}:${line}`, DIM, false)}  ${entry.rule}  (${entry.suppressionType}, ${entry.guardKind})`,
  );
  out.push("    remediate with:");
  const record: Array<[string, string]> = [
    ["rule", entry.rule],
    ["suppression_type", entry.suppressionType],
    ["fingerprint", entry.fingerprint],
    ["file", entry.file],
    ["type", "temporary"],
    ["reason", "<why this suppression is necessary>"],
    ["owner", "<owning team>"],
    ["reference", "<issue or PR link>"],
    ["expires", "<YYYY-MM-DD>"],
  ];
  record.forEach(([key, value], i) => {
    out.push(`    ${i === 0 ? "- " : "  "}${key}: ${value}`);
  });
  return out;
}

function renderError(err: RecordError): string {
  return `error[${err.code}]: ${err.message}`;
}

function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}
