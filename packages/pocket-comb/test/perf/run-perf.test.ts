import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  CORPUS_CONFIG_PATH,
  compareScale,
  evaluate,
  loadBaseline,
  measureScale,
  platformId,
  platformKey,
  runPerfCli,
  updateBaseline,
  type BaselineFile,
  type PerfMeasurement,
  type PlatformKey,
  type ScaleMeasurement,
} from "../../perf/run-perf.js";
import { cleanupTemps, tempDir } from "../harness.js";

after(cleanupTemps);

function stage(stage_: string, medianMs: number) {
  return { stage: stage_, runsMs: [medianMs], medianMs, minMs: medianMs, maxMs: medianMs };
}

function scale(scale_: string, files: number, medians: Record<string, number>): ScaleMeasurement {
  return {
    scale: scale_,
    files,
    warmup: 1,
    runs: 5,
    stages: Object.entries(medians).map(([name, ms]) => stage(name, ms)),
  };
}

function measurement(scales: ScaleMeasurement[], platform: PlatformKey = platformKey()): PerfMeasurement {
  return { platform, measuredAt: "2026-01-01T00:00:00.000Z", scales };
}

/** A baseline keyed to the measurement's platform, built by hand (not via the code under test). */
function baselineFor(source: PerfMeasurement): BaselineFile {
  const entry = {
    platform: source.platform,
    scales: {} as Record<string, { files: number; warmup: number; runs: number; stages: Record<string, number> }>,
  };
  for (const s of source.scales) {
    const stages: Record<string, number> = {};
    for (const st of s.stages) stages[st.stage] = st.medianMs;
    entry.scales[s.scale] = { files: s.files, warmup: s.warmup, runs: s.runs, stages };
  }
  return { schema: 1, baselines: { [platformId(source.platform)]: entry } };
}

function silentIo(): { out: (line: string) => void; err: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { out: (line) => lines.push(line), err: (line) => lines.push(line), lines };
}

test("the 1.15 threshold is exact: 115 passes, anything above fails", () => {
  const baseline = baselineFor(measurement([scale("default", 10, { discover: 100, lint: 1000 })]));
  const atLimit = evaluate(
    measurement([scale("default", 10, { discover: 115, lint: 1000 })]),
    baseline,
    1.15,
  );
  assert.equal(atLimit.ok, true, "exactly at the limit is not a regression");

  const over = evaluate(
    measurement([scale("default", 10, { discover: 115.001, lint: 1000 })]),
    baseline,
    1.15,
  );
  assert.equal(over.ok, false);
  assert.equal(over.failures.length, 1);
  assert.equal(over.failures[0]!.scale, "default");
  assert.equal(over.failures[0]!.stage, "discover");
  assert.ok(over.failures[0]!.ratio > 1.15);
});

test("a slower lint stage also trips the threshold", () => {
  const baseline = baselineFor(measurement([scale("default", 10, { discover: 20, lint: 400 })]));
  const verdict = evaluate(
    measurement([scale("default", 10, { discover: 20, lint: 480 })]),
    baseline,
    1.15,
  );
  assert.equal(verdict.ok, false);
  assert.deepEqual(
    verdict.failures.map((failure) => failure.stage),
    ["lint"],
  );
});

test("a missing platform baseline is reported, not treated as a regression", () => {
  const baseline = baselineFor(
    measurement([scale("default", 10, { discover: 100, lint: 1000 })], {
      os: "plan9",
      cpuModel: "imaginary",
      node: "v0.0.0",
    }),
  );
  const verdict = evaluate(measurement([scale("default", 10, { discover: 100, lint: 1000 })]), baseline, 1.15);
  assert.equal(verdict.missing, true);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.length, 0);
});

test("a sub-10ms baseline is reported but not gated", () => {
  const baseline = baselineFor(measurement([scale("default", 10, { discover: 5, lint: 1000 })]));
  const measured = measurement([scale("default", 10, { discover: 50, lint: 1000 })]);
  const entry = baseline.baselines[platformId(measured.platform)]!;
  const rows = compareScale(measured.scales[0]!, entry.scales.default, 1.15);
  assert.equal(rows[0]!.gated, false, "a 5 ms baseline is below the gate floor");
  assert.equal(rows[0]!.ok, true);
  assert.equal(rows[1]!.gated, true, "a 1000 ms baseline is gated");
  assert.equal(evaluate(measured, baseline, 1.15).ok, true, "tiny stages never fail the suite");
});

test("baseline round-trips through updateBaseline / loadBaseline, keyed by platform", () => {
  const path = join(tempDir("pc-perf-baseline-"), "baseline.json");
  const measured = measurement([
    scale("default", 2000, { discover: 12.3456, lint: 345.6789 }),
    scale("stress", 20000, { discover: 98.7654, lint: 2600.111 }),
  ]);
  updateBaseline(path, measured);

  const loaded = loadBaseline(path);
  const entry = loaded.baselines[platformId(measured.platform)];
  assert.ok(entry, "the platform entry was written");
  assert.equal(entry!.platform.cpuModel, measured.platform.cpuModel);
  assert.equal(entry!.scales.default!.files, 2000);
  assert.equal(entry!.scales.default!.stages.discover, 12.346);
  assert.equal(entry!.scales.stress!.stages.lint, 2600.111);
  assert.equal(evaluate(measured, loaded, 1.15).ok, true, "a freshly pinned baseline passes");
});

test(
  "an artificially injected slowdown beyond 15% fails the run",
  { timeout: 120_000 },
  async () => {
    const dir = tempDir("pc-perf-slow-");
    const corpusDir = join(dir, "corpus");
    const measured = await measureScale({
      scale: "tiny",
      files: 120,
      seed: 7,
      corpusDir,
      configPath: CORPUS_CONFIG_PATH,
      warmup: 1,
      runs: 5,
    });
    const baseline = baselineFor(measurement([measured]));
    assert.equal(evaluate(measurement([measured]), baseline, 1.15).ok, true, "clean run passes");

    const lintMedian = measured.stages.find((s) => s.stage === "lint")!.medianMs;
    const slowed = await measureScale({
      scale: "tiny",
      files: 120,
      seed: 7,
      corpusDir,
      configPath: CORPUS_CONFIG_PATH,
      warmup: 1,
      runs: 5,
      stageDelays: { lint: lintMedian * 1.5 },
    });
    const verdict = evaluate(measurement([slowed]), baseline, 1.15);
    assert.equal(verdict.ok, false, "the injected slowdown fails the suite");
    const lintFailure = verdict.failures.find((failure) => failure.stage === "lint");
    assert.ok(lintFailure, "lint is the regressed stage");
    assert.ok(lintFailure!.ratio > 1.15);
  },
);

test(
  "--update-baseline re-pins, and the next clean run passes",
  { timeout: 240_000 },
  async () => {
    const dir = tempDir("pc-perf-cli-");
    const baselinePath = join(dir, "baseline.json");
    const corpusDir = join(dir, "corpus");
    const io = silentIo();
    // The default scale: its stages are large enough that a 1.15 gate is stable
    // (a sub-millisecond custom scale is not — see the warmup probe in the report).
    const common = ["--scales", "default", "--seed", "3", "--corpus-dir", corpusDir, "--baseline", baselinePath];

    assert.equal(await runPerfCli([...common, "--update-baseline"], io), 0, io.lines.join("\n"));
    const pinned = loadBaseline(baselinePath);
    const entry = pinned.baselines[platformId(platformKey())];
    assert.ok(entry, "the running platform was pinned");
    assert.ok(entry!.scales.default, "the default scale was recorded");
    assert.ok(entry!.scales.default!.stages.lint! > 0, "a lint median was pinned");

    assert.equal(await runPerfCli(common, io), 0, io.lines.join("\n"));
  },
);

test("a run with no committed baseline exits 0 unless --require-baseline", async () => {
  const dir = tempDir("pc-perf-nobase-");
  const common = [
    "--files",
    "40",
    "--seed",
    "5",
    "--corpus-dir",
    join(dir, "corpus"),
    "--baseline",
    join(dir, "missing.json"),
  ];
  assert.equal(await runPerfCli(common, silentIo()), 0);
  assert.equal(await runPerfCli([...common, "--require-baseline"], silentIo()), 1);
});

test("the harness measures the shared full-file scan over every file at µs scale", async () => {
  const dir = tempDir("pc-perf-scan-");
  const measured = await measureScale({
    scale: "tiny",
    files: 80,
    seed: 7,
    corpusDir: join(dir, "corpus"),
    configPath: CORPUS_CONFIG_PATH,
    warmup: 1,
    runs: 3,
  });
  const scanFull = measured.stages.find((s) => s.stage === "scan-full");
  assert.ok(scanFull, "the shared full-file scan is a measured stage");
  assert.ok(scanFull!.perFileUs !== undefined, "its cost is reported per file");
  assert.ok(
    scanFull!.perFileUs! < 200,
    `the full-file scan should be µs-scale, got ${scanFull!.perFileUs} µs/file`,
  );
});

test("platformKey reports os, CPU model, and Node version", () => {
  const key = platformKey();
  assert.ok(key.os.length > 0);
  assert.ok(key.cpuModel.length > 0);
  assert.match(key.node, /^v\d+\./);
  assert.equal(platformId(key), `${key.os}|${key.cpuModel}|${key.node}`);
});
