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

/**
 * The kinds of edit the engine records in the ledger (spec §13), in canonical
 * order. Exported as a value so rollups (`by type`) sort stably across runs.
 */
export const EDIT_TYPES = ["insert", "prepend", "strip", "rename", "prune", "fix"] as const;

export type EditType = (typeof EDIT_TYPES)[number];

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
  /**
   * Directives the action found but could not act on (ticket 09+): bare guards
   * during `remove`, unscopable bare directives during `cleanup`. Additive to the
   * notes' contract so the command can list them as not-actionable.
   */
  notActionable?: NotActionableDirective[];
}

/**
 * A directive an action recognised but deliberately left untouched (spec §6.3,
 * §6.5). Carried from the engine through the pool so the command can report it.
 */
export interface NotActionableDirective {
  file: string;
  /** 1-based line the directive sits on. */
  line: number;
  form: DirectiveForm;
  /** Why it was skipped. */
  reason: "bare";
  /** The directive line's text, without a trailing CR. */
  text: string;
}

/** Re-exported ESLint message shape, so `types.ts` stays the shared vocabulary. */
export type LintMessage = import("eslint").Linter.LintMessage;
