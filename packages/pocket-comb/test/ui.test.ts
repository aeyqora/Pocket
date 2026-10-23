import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createSpinner,
  formatCompletion,
  summarizeRun,
  writeCompletion,
  writeNotActionable,
} from "../src/ui.js";
import { cleanupTemps, fakeIo, tempDir } from "./harness.js";
import type { EditRecord } from "../src/types.js";

after(cleanupTemps);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test("the completion line matches the spec's exact shape", () => {
  assert.equal(
    formatCompletion({
      filesTouched: 37,
      edits: 214,
      inserted: 152,
      prepended: 62,
      elapsedMs: 8400,
    }),
    "Done: 37 files touched, 214 edits (152 inserted, 62 prepended) — 8.4s",
  );
});

test("summarizeRun counts touched files and edits by type", () => {
  const edit = (editType: EditRecord["editType"]): EditRecord => ({
    file: "a.js",
    line: 1,
    rule: "r",
    editType,
    form: "next-line",
  });
  const summary = summarizeRun(
    [
      { changed: true, edits: [edit("insert"), edit("insert")] },
      { changed: true, edits: [edit("prepend")] },
      { changed: false, edits: [] },
    ],
    1000,
  );
  assert.deepEqual(summary, {
    filesTouched: 2,
    edits: 3,
    inserted: 2,
    prepended: 1,
    fixed: 0,
    elapsedMs: 1000,
  });
});

test("writeCompletion prints the completion line with a trailing newline", () => {
  const fake = fakeIo({ cwd: tempDir() });
  writeCompletion(fake.io.output, {
    filesTouched: 1,
    edits: 0,
    inserted: 0,
    prepended: 0,
    elapsedMs: 250,
  });
  assert.equal(fake.stdout(), "Done: 1 files touched, 0 edits (0 inserted, 0 prepended) — 0.3s\n");
});

test("writeNotActionable keeps bare-only wording and explains context skips in a mixed run", () => {
  const fake = fakeIo({ cwd: tempDir() });
  const cwd = fake.io.cwd;

  writeNotActionable(fake.io.output, cwd, [
    {
      notActionable: [
        {
          kind: "bare",
          file: join(cwd, "a.js"),
          line: 3,
          form: "next-line",
          text: "// eslint-disable-next-line",
        },
      ],
    },
  ]);
  assert.equal(
    fake.stdout(),
    "Not actionable: 1 bare directives (no rule list)\n" +
      "  a.js:3 next-line // eslint-disable-next-line\n",
  );

  const mixed = fakeIo({ cwd });
  writeNotActionable(mixed.io.output, cwd, [
    {
      notActionable: [
        {
          kind: "bare",
          file: join(cwd, "a.js"),
          line: 3,
          form: "next-line",
          text: "// eslint-disable-next-line",
        },
        {
          kind: "context",
          file: join(cwd, "b.jsx"),
          line: 7,
          text: "  ${value}",
          reason: "inside a template literal",
        },
      ],
    },
  ]);
  assert.equal(
    mixed.stdout(),
    "Not actionable: 2 items\n" +
      "  a.js:3 next-line // eslint-disable-next-line — bare directive (no rule list)\n" +
      "  b.jsx:7   ${value} — inside a template literal\n",
  );
});

test("the spinner animates on a TTY without blocking the event loop", async () => {
  const fake = fakeIo({ cwd: tempDir(), tty: true });
  const spinner = createSpinner({
    output: fake.io.stderr,
    tty: true,
    intervalMs: 5,
    frames: ["A", "B", "C"],
  });

  // An independent timer proves the main thread stays responsive while the
  // spinner runs: the spinner never occupies the loop, it only schedules.
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 5);

  spinner.update({ stage: "lint", done: 2, total: 9 });
  await delay(60);
  spinner.update({ stage: "lint", done: 5, total: 9 });
  await delay(30);
  spinner.stop();
  clearInterval(ticker);

  const text = fake.stderr();
  assert.match(text, /lint 2\/9/, "the stage and counts are rendered");
  assert.match(text, /lint 5\/9/, "progress updates redraw");
  assert.ok(text.includes("A") && text.includes("B") && text.includes("C"), "frames advance");
  assert.ok(ticks >= 2, `the event loop kept running timers (ticks=${ticks})`);

  // After stop, no further frames are written.
  const afterStop = fake.stderr();
  await delay(30);
  assert.equal(fake.stderr(), afterStop, "stop clears the interval");
});

test("a non-TTY spinner writes nothing, keeping pipes clean", async () => {
  const fake = fakeIo({ cwd: tempDir(), tty: false });
  const spinner = createSpinner({ output: fake.io.stderr, tty: false, intervalMs: 5 });
  spinner.update({ stage: "lint", done: 1, total: 3 });
  await delay(30);
  spinner.stop();
  assert.equal(fake.stderr(), "");
});
