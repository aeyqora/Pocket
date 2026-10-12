import {
  ACTIONS,
  REPORT_FORMATS,
  type Action,
  type ReportFormat,
  type RunMode,
} from "./types.js";

/**
 * The CLI surface: one verb plus the full flag table from spec §4. Absent values
 * are `null` rather than `undefined` so a caller can tell "not given" from
 * "given as empty"; the parser rejects empty values outright.
 */
export interface ParsedInvocation {
  kind: "invocation";
  /** `null` only for `--help` / `--version` with no verb. */
  action: Action | null;
  help: boolean;
  version: boolean;
  config: string | null;
  target: string | null;
  mode: RunMode | null;
  from: string | null;
  to: string | null;
  reason: string | null;
  fixFirst: boolean;
  reuseBlocks: boolean;
  format: ReportFormat | null;
  out: string | null;
  noReport: boolean;
  workers: number | null;
  serial: boolean;
  batchSize: number | null;
  extensions: string[] | null;
}

export interface ParseError {
  kind: "error";
  message: string;
}

export type ParseResult = ParsedInvocation | ParseError;

const VALUE_FLAGS = new Set([
  "-c",
  "--config",
  "-t",
  "--target",
  "--from",
  "--to",
  "--reason",
  "--format",
  "--out",
  "--workers",
  "--batch-size",
  "--extensions",
]);

/** Flags that only `suppress` reads; using them elsewhere is a usage error. */
const SUPPRESS_ONLY = ["--reason", "--fix-first", "--reuse-blocks"] as const;

function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

function blank(): ParsedInvocation {
  return {
    kind: "invocation",
    action: null,
    help: false,
    version: false,
    config: null,
    target: null,
    mode: null,
    from: null,
    to: null,
    reason: null,
    fixFirst: false,
    reuseBlocks: false,
    format: null,
    out: null,
    noReport: false,
    workers: null,
    serial: false,
    batchSize: null,
    extensions: null,
  };
}

function error(message: string): ParseError {
  return { kind: "error", message };
}

export function parseArgs(argv: string[]): ParseResult {
  const parsed = blank();
  let seenDryRun = false;
  let seenApply = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--version" || token === "-V") {
      parsed.version = true;
      continue;
    }

    let name = token;
    let inline: string | undefined;
    if (token.startsWith("--") && token.includes("=")) {
      const eq = token.indexOf("=");
      name = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }

    if (!name.startsWith("-") || name === "-") {
      if (parsed.action !== null) return error(`unexpected argument '${token}'\n${usage()}`);
      if (!isAction(token)) return error(`unknown action '${token}'\n${usage()}`);
      parsed.action = token;
      continue;
    }

    const takesValue = VALUE_FLAGS.has(name);
    let value: string | undefined = inline;
    if (takesValue) {
      if (value === undefined) {
        i += 1;
        value = argv[i];
      }
      if (value === undefined || value === "") {
        return error(`flag '${name}' requires a value\n${usage()}`);
      }
    } else if (inline !== undefined) {
      return error(`flag '${name}' does not take a value\n${usage()}`);
    }

    switch (name) {
      case "-c":
      case "--config":
        parsed.config = value!;
        break;
      case "-t":
      case "--target":
        parsed.target = value!;
        break;
      case "--from":
        parsed.from = value!;
        break;
      case "--to":
        parsed.to = value!;
        break;
      case "--reason":
        parsed.reason = value!;
        break;
      case "--fix-first":
        parsed.fixFirst = true;
        break;
      case "--reuse-blocks":
        parsed.reuseBlocks = true;
        break;
      case "--dry-run":
        seenDryRun = true;
        parsed.mode = "dry-run";
        break;
      case "--apply":
        seenApply = true;
        parsed.mode = "apply";
        break;
      case "--format": {
        if (!(REPORT_FORMATS as readonly string[]).includes(value!)) {
          return error(
            `flag '--format' expects one of ${REPORT_FORMATS.join(" | ")}, got '${value}'\n${usage()}`,
          );
        }
        parsed.format = value as ReportFormat;
        break;
      }
      case "--out":
        parsed.out = value!;
        break;
      case "--no-report":
        parsed.noReport = true;
        break;
      case "--workers":
      case "--batch-size": {
        const count = positiveInteger(value!);
        if (count === null) {
          return error(`flag '${name}' expects a positive integer, got '${value}'\n${usage()}`);
        }
        if (name === "--workers") parsed.workers = count;
        else parsed.batchSize = count;
        break;
      }
      case "--extensions": {
        const extensions = value!
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        if (extensions.length === 0) {
          return error(`flag '--extensions' expects a comma-separated list\n${usage()}`);
        }
        parsed.extensions = extensions;
        break;
      }
      case "--serial":
        parsed.serial = true;
        break;
      default:
        return error(`unknown flag '${name}'\n${usage()}`);
    }
  }

  if (seenDryRun && seenApply) {
    return error(`--dry-run and --apply are mutually exclusive\n${usage()}`);
  }
  if ((parsed.from === null) !== (parsed.to === null)) {
    const missing = parsed.from === null ? "--from" : "--to";
    const present = parsed.from === null ? "--to" : "--from";
    return error(`'${present}' requires '${missing}'\n${usage()}`);
  }

  if (!parsed.help && !parsed.version && parsed.action !== null) {
    const invalid = applicabilityError(parsed.action, parsed);
    if (invalid !== null) return error(invalid + "\n" + usage());
  }

  return parsed;
}

function positiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  return Number(value);
}

function applicabilityError(action: Action, parsed: ParsedInvocation): string | null {
  if (action !== "replace" && (parsed.from !== null || parsed.to !== null)) {
    const flag = parsed.from !== null ? "--from" : "--to";
    return `flag '${flag}' only applies to replace`;
  }
  if (action !== "suppress") {
    for (const flag of SUPPRESS_ONLY) {
      const used =
        (flag === "--reason" && parsed.reason !== null) ||
        (flag === "--fix-first" && parsed.fixFirst) ||
        (flag === "--reuse-blocks" && parsed.reuseBlocks);
      if (used) return `flag '${flag}' only applies to suppress`;
    }
  }
  if (action === "inventory" && parsed.mode !== null) {
    return `flag '--${parsed.mode}' does not apply to inventory (read-only)`;
  }
  return null;
}

export function usage(action: Action | null = null): string {
  const head = action === null ? "pocket-comb <action> [flags]" : `pocket-comb ${action} [flags]`;
  return [
    `Usage: ${head}`,
    "",
    "Actions:",
    `  ${ACTIONS.join(" | ")}`,
    "",
    "Flags:",
    "  -c, --config <path>       Action config; auto-detected from the cwd",
    "  -t, --target <path|glob>  Target root; default cwd (after settings)",
    "      --dry-run | --apply   Non-interactive default is dry run; --apply writes",
    "      --from <rule>         replace: rename source rule (with --to)",
    "      --to <rule>           replace: rename destination rule (with --from)",
    "      --reason <text>       suppress: append ' -- <text>' to inserted directives",
    "      --fix-first           suppress: autofix first, then suppress the remainder",
    "      --reuse-blocks        suppress: prepend into enclosing block/file-level guards",
    "      --format csv|json|html  Report format; default html",
    "      --out <path|->        Report destination; default pocket-comb-report.<ext>; '-' is stdout",
    "      --no-report           Skip the report",
    "      --workers <n>         Pool size; default ceil(cores x 0.75), min 1",
    "      --serial              No pool; single in-process instance",
    "      --batch-size <n>      Files per task; default 16",
    "      --extensions <csv>    Discovery extensions; default .js,.mjs,.cjs,.jsx,.ts,.mts,.cts,.tsx",
    "      --version, --help     Print this and exit",
  ].join("\n");
}
