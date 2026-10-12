import type { EditRecord } from "./types.js";

/** What the spinner renders: the stage name plus a done/total count. */
export interface Progress {
  stage: string;
  done: number;
  total: number;
}

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface SpinnerOptions {
  /** Defaults to stderr so stdout stays clean for `--out -`. */
  output?: NodeJS.WritableStream;
  /** Defaults to the stream's `isTTY`; a non-TTY gets a silent spinner. */
  tty?: boolean;
  intervalMs?: number;
  frames?: readonly string[];
}

export interface Spinner {
  update(progress: Progress): void;
  stop(): void;
}

/**
 * The hand-rolled, main-thread spinner (spec §4). It only schedules a timer and
 * writes a redrawn line; all CPU work lives in the worker pool, so the event loop
 * (and therefore the animation) can never freeze on lint or apply. A non-TTY
 * stream gets a silent spinner: pipes must never carry frame noise.
 */
export function createSpinner(options: SpinnerOptions = {}): Spinner {
  const output = options.output ?? process.stderr;
  const tty = options.tty ?? (output as { isTTY?: boolean }).isTTY === true;
  if (!tty) return { update() {}, stop() {} };

  const frames = options.frames ?? DEFAULT_FRAMES;
  const intervalMs = options.intervalMs ?? 80;
  let frame = 0;
  let current: Progress = { stage: "starting", done: 0, total: 0 };

  const render = (): void => {
    output.write(`\r\u001b[2K${frames[frame]!} ${current.stage} ${current.done}/${current.total}`);
  };

  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    render();
  }, intervalMs);
  render();

  return {
    update(progress: Progress): void {
      current = progress;
      render();
    },
    stop(): void {
      clearInterval(timer);
      output.write("\r\u001b[2K");
    },
  };
}

/** The completion confirmation's numbers (spec §4). */
export interface CompletionSummary {
  filesTouched: number;
  edits: number;
  inserted: number;
  prepended: number;
  elapsedMs: number;
}

/**
 * The completion confirmation, exact shape from spec §4:
 * `Done: 37 files touched, 214 edits (152 inserted, 62 prepended) — 8.4s`.
 */
export function formatCompletion(summary: CompletionSummary): string {
  return (
    `Done: ${summary.filesTouched} files touched, ${summary.edits} edits ` +
    `(${summary.inserted} inserted, ${summary.prepended} prepended) — ` +
    `${(summary.elapsedMs / 1000).toFixed(1)}s`
  );
}

/** Roll the per-file outcomes into the completion summary. */
export function summarizeRun(
  outcomes: ReadonlyArray<{ changed: boolean; edits: readonly EditRecord[] }>,
  elapsedMs: number,
): CompletionSummary {
  let filesTouched = 0;
  let edits = 0;
  let inserted = 0;
  let prepended = 0;

  for (const outcome of outcomes) {
    if (outcome.changed) filesTouched += 1;
    edits += outcome.edits.length;
    for (const edit of outcome.edits) {
      if (edit.editType === "insert") inserted += 1;
      else if (edit.editType === "prepend") prepended += 1;
    }
  }

  return { filesTouched, edits, inserted, prepended, elapsedMs };
}

/** Print the completion confirmation, newline-terminated. */
export function writeCompletion(
  output: NodeJS.WritableStream,
  summary: CompletionSummary,
): void {
  output.write(`${formatCompletion(summary)}\n`);
}
