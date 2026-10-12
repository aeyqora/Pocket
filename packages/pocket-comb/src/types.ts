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
