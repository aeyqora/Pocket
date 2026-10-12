/** The six mass operations. Chosen per run; never encoded in the action config. */
export const ACTIONS = [
  "suppress",
  "fix",
  "remove",
  "replace",
  "cleanup",
  "inventory",
] as const;

export type Action = (typeof ACTIONS)[number];

/** Report formats the hand-rolled renderers can emit. */
export const REPORT_FORMATS = ["csv", "json", "html"] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** Whether a mutating run writes or only reports its impact. */
export type RunMode = "dry-run" | "apply";

/** A structured-cloneable JSON value: the wire shape of per-action parameters. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The four directive shapes a scan understands (spec §6, CONTEXT.md). */
export type DirectiveForm = "next-line" | "line" | "block" | "file-level";

/** The kinds of edit the engine records in the ledger (spec §13). */
export type EditType = "insert" | "prepend" | "strip" | "rename" | "prune" | "fix";

/**
 * One edit-ledger record (spec §13). Defined here rather than in `ledger.ts`
 * because `BatchOutcome` needs it and the worker pool predates that module;
 * ticket 05's `ledger.ts` rolls reports up from this same record.
 */
export interface EditRecord {
  file: string;
  /** 1-based line the edit anchors to. */
  line: number;
  rule: string;
  editType: EditType;
  form: DirectiveForm | null;
  before?: string;
  after?: string;
}

/**
 * Per-file outcome the worker posts back for a batch (architecture notes,
 * `pool.ts` + `worker.ts` contract). `messages` are cloneable plain objects.
 */
export interface BatchOutcome {
  /** Absolute path. */
  filePath: string;
  messages: LintMessage[];
  /** Empty until a real action strategy lands (ticket 05+). */
  edits: EditRecord[];
  changed: boolean;
  /** Planned/final text when changed and still a dry run; omitted on apply. */
  output?: string;
  /** Action-specific counters. */
  stats: Record<string, number>;
}

/** Re-exported ESLint message shape, so `types.ts` stays the shared vocabulary. */
export type LintMessage = import("eslint").Linter.LintMessage;
