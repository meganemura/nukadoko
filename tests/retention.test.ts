import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { runCli } from "../src/cli/run-cli.js";
import { messagesRunOutputPath } from "../src/record/messages-output.js";
import {
  applyRetention,
  formatRetention,
  planAgeRetention,
  planRunRetention,
  type RunSummary,
} from "../src/record/retention.js";
import { readExportsManifest, runExportsManifestPath } from "../src/record/run-exports.js";
import { runResultPath, writeRunResult } from "../src/record/run-result.js";
import { copyFixtureToTempDir, createCaptureSink, latestRunJson, removeTempDir, sourceNodeArgs, stepRecordIds } from "./helpers/fixtures.js";

// Responsibility: what retention removes and what it must never touch.
// The two planners are pure and get properties; `applyRetention` gets a
// state directory seeded by hand (the same stance tests/clean.test.ts
// takes: a shape test, not a re-test of what `nuka run` writes); and one
// real `nuka run` at the end shows the hook is wired and the manifest a
// run leaves is the one retention consumes.

describe("planRunRetention", () => {
  const runsGen = gs
    .arrays(gs.integers({ minValue: 0, maxValue: 1_000_000 }), { minSize: 0, maxSize: 30 })
    .map((starts) => starts.map((startedAt, index): RunSummary => ({ runId: `run-${index}`, startedAt })));

  it("keeps at most `keep` runs, and every kept run started no earlier than every dropped one", () =>
    hegel.test((tc) => {
      const runs = tc.draw(runsGen);
      const keep = tc.draw(gs.integers({ minValue: 1, maxValue: 40 }));
      const plan = planRunRetention(runs, keep);
      expect(plan.kept.length).toBe(Math.min(keep, runs.length));
      expect([...plan.kept, ...plan.dropped].sort()).toEqual(runs.map((run) => run.runId).sort());
      const startedAt = new Map(runs.map((run) => [run.runId, run.startedAt]));
      for (const kept of plan.kept) {
        for (const dropped of plan.dropped) {
          expect(startedAt.get(kept)!).toBeGreaterThanOrEqual(startedAt.get(dropped)!);
        }
      }
    }));

  it("does not depend on the order runs arrive in", () =>
    hegel.test((tc) => {
      const runs = tc.draw(runsGen);
      const keep = tc.draw(gs.integers({ minValue: 1, maxValue: 40 }));
      // A drawn permutation, not a fixed reversal, so two runs tied on
      // startedAt also arrive in either order.
      const keys = runs.map(() => tc.draw(gs.integers({ minValue: 0, maxValue: 1_000_000 })));
      const shuffled = runs
        .map((run, index) => ({ run, key: keys[index]! }))
        .sort((a, b) => a.key - b.key)
        .map((entry) => entry.run);
      expect(planRunRetention(shuffled, keep)).toEqual(planRunRetention(runs, keep));
    }));

  it("breaks a tie on startedAt by run id, the later id ranking newer", () => {
    const plan = planRunRetention(
      [
        { runId: "run-20260901-000000-aaaa", startedAt: 5 },
        { runId: "run-20260901-000000-bbbb", startedAt: 5 },
      ],
      1,
    );
    expect(plan.kept).toEqual(["run-20260901-000000-bbbb"]);
    expect(plan.dropped).toEqual(["run-20260901-000000-aaaa"]);
  });
});

describe("planAgeRetention", () => {
  it("removes exactly the dated entries older than the cutoff, never an undated one", () =>
    hegel.test((tc) => {
      const entries = tc
        .draw(gs.arrays(gs.optional(gs.integers({ minValue: 0, maxValue: 1_000 })), { minSize: 0, maxSize: 30 }))
        .map((at, index) => ({ id: `e-${index}`, at: at ?? null }));
      const cutoff = tc.draw(gs.integers({ minValue: 0, maxValue: 1_000 }));
      const removed = planAgeRetention(entries, cutoff);
      expect(removed).toEqual(entries.filter((entry) => entry.at !== null && entry.at < cutoff).map((entry) => entry.id));
    }));
});

describe("applyRetention", () => {
  let rootDir: string;
  const stateDir = ".nukadoko";
  const messagesOutputRel = path.join(stateDir, "export", "messages.ndjson");
  const now = new Date("2026-09-02T12:00:00Z");
  const policy = { runs: 2, adHocDays: 7 };

  function abs(...segments: string[]): string {
    return path.join(rootDir, ...segments);
  }

  const current = { runId: "run-current", startedAt: Date.parse("2026-09-02T00:00:00Z") };

  /** A run.json naming `scenarios`, each with its step record ids and its
   * evidence directory, with paths relative to the run directory. */
  function writeEnded(runId: string, startedAt: string, scenarios: readonly { id: string; steps: readonly string[] }[] = []): void {
    writeRunResult(
      rootDir,
      stateDir,
      runId,
      JSON.stringify({
        schema_version: 2,
        nukadoko: "0.0.0-test",
        command: "run",
        verdict: "passed",
        findings: [],
        run_id: runId,
        started_at: startedAt,
        finished_at: startedAt,
        scenarios: scenarios.map((scenario) => ({
          scenario_record_id: scenario.id,
          started_at: startedAt,
          finished_at: startedAt,
          steps: scenario.steps.map((id) => ({ text: "x", status: "passed", step_record_id: id, record: path.join("steps", id) })),
          hooks: [],
          evidence: { dir: path.join("scenarios", scenario.id), screenshots: [] },
        })),
      }),
    );
  }

  /** `<stateDir>/runs/<runId>/...`, absolute. */
  function inRun(runId: string, ...segments: string[]): string {
    return abs(stateDir, "runs", runId, ...segments);
  }

  /** One run directory: `count` scenarios, each with an evidence directory
   * and one step record, one manifest naming one export file per scenario,
   * and one messages stream. An unmarked run has no run.json. The run
   * directory carries its start as the time it was last written. */
  async function seedRun(runId: string, startedAt: string, count = 1, marked = true): Promise<void> {
    const resultsDir = abs(stateDir, "export", "allure-results");
    await mkdir(resultsDir, { recursive: true });
    const manifestPath = runExportsManifestPath(rootDir, stateDir, runId);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    const manifestLines: string[] = [];
    const scenarios: { id: string; steps: string[] }[] = [];
    const at = new Date(Number.isNaN(Date.parse(startedAt)) ? now.getTime() : Date.parse(startedAt));
    for (let index = 0; index < count; index += 1) {
      const scenarioId = `scn-${runId}-${index}`;
      const stepId = `step-${runId}-${index}`;
      const scenarioDir = inRun(runId, "scenarios", scenarioId);
      await mkdir(scenarioDir, { recursive: true });
      await writeFile(path.join(scenarioDir, "final.png"), "png");
      scenarios.push({ id: scenarioId, steps: [stepId] });
      await mkdir(inRun(runId, "steps", stepId), { recursive: true });
      await writeFile(
        inRun(runId, "steps", stepId, "record.json"),
        JSON.stringify({ run_id: runId, started_at: at.toISOString(), finished_at: at.toISOString() }),
      );
      const exportFile = path.join(stateDir, "export", "allure-results", `${runId}-${index}-result.json`);
      await writeFile(abs(exportFile), "{}");
      manifestLines.push(exportFile);
    }
    await writeFile(manifestPath, `${manifestLines.join("\n")}\n`);
    if (marked) writeEnded(runId, startedAt, scenarios);
    await utimes(inRun(runId), at, at);
    await writeFile(messagesRunOutputPath(abs(messagesOutputRel), runId), "line\n");
  }

  async function seedDoStep(stepId: string, finishedAt: string): Promise<void> {
    await mkdir(abs(stateDir, "do", stepId), { recursive: true });
    await writeFile(
      abs(stateDir, "do", stepId, "record.json"),
      JSON.stringify({ run_id: null, started_at: finishedAt, finished_at: finishedAt }),
    );
  }

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-retention-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("removes every run directory older than the newest `runs` whole, with its export files and messages stream", async () => {
    await seedRun("run-a", "2026-09-01T00:00:00Z", 2);
    await seedRun("run-b", "2026-09-01T06:00:00Z");
    await seedRun("run-c", "2026-09-01T12:00:00Z");
    // A shared file: written by every run, listed by none.
    await writeFile(abs(stateDir, "export", "allure-results", "environment.properties"), "x=y\n");

    // The run applying retention counts as one of the newest three.
    const threeRuns = { runs: 3, adHocDays: 7 };
    const outcome = await applyRetention({ rootDir, stateDir, policy: threeRuns, now, messagesOutputRel, currentRun: current });
    expect(outcome).toEqual({ runsKept: 3, runsRemoved: 1, unownedRemoved: 0 });

    for (const gone of [
      inRun("run-a"),
      abs(stateDir, "export", "allure-results", "run-a-0-result.json"),
      abs(stateDir, "export", "allure-results", "run-a-1-result.json"),
      messagesRunOutputPath(abs(messagesOutputRel), "run-a"),
    ]) {
      expect(existsSync(gone), gone).toBe(false);
    }
    for (const kept of [
      inRun("run-b", "scenarios", "scn-run-b-0"),
      inRun("run-c", "steps", "step-run-c-0"),
      abs(stateDir, "export", "allure-results", "run-b-0-result.json"),
      abs(stateDir, "export", "allure-results", "run-c-0-result.json"),
      abs(stateDir, "export", "allure-results", "environment.properties"),
      messagesRunOutputPath(abs(messagesOutputRel), "run-c"),
      runExportsManifestPath(rootDir, stateDir, "run-b"),
    ]) {
      expect(existsSync(kept), kept).toBe(true);
    }
    expect(formatRetention(outcome, threeRuns)).toBe("retention: removed 1 run older than the newest 3 (retention.runs)");
  });

  it("leaves a run.json whose started_at does not parse out of the ranking, so its run never takes the newest run's place", async () => {
    await seedRun("run-older", "2026-08-31T00:00:00Z");
    await seedRun("run-newest", "2026-09-01T00:00:00Z");
    await seedRun("run-undated", "not a date");

    const outcome = await applyRetention({ rootDir, stateDir, policy: { runs: 2, adHocDays: 7 }, now, messagesOutputRel, currentRun: current });
    expect(outcome).toEqual({ runsKept: 2, runsRemoved: 1, unownedRemoved: 0 });
    expect(existsSync(inRun("run-older"))).toBe(false);
    expect(existsSync(inRun("run-newest"))).toBe(true);
    // The undated run leaves by age, from its directory's mtime.
    expect(existsSync(inRun("run-undated"))).toBe(true);
  });

  it("dates a run by the start in its run.json, so a long run that began first is the older one", async () => {
    await seedRun("run-long", "2026-09-01T00:00:00Z");
    await seedRun("run-short", "2026-09-01T01:00:00Z");

    const outcome = await applyRetention({ rootDir, stateDir, policy: { runs: 2, adHocDays: 7 }, now, messagesOutputRel, currentRun: current });
    expect(outcome.runsRemoved).toBe(1);
    expect(existsSync(inRun("run-short"))).toBe(true);
    expect(existsSync(inRun("run-long"))).toBe(false);
  });

  it("keeps a run without a marker until it is older than adHocDays, then removes it like any other", async () => {
    await seedRun("run-old", "2026-08-20T00:00:00Z", 1, false);
    await seedRun("run-young", "2026-08-30T00:00:00Z", 1, false);
    await seedRun("run-new", "2026-09-01T00:00:00Z");

    const outcome = await applyRetention({ rootDir, stateDir, policy, now, messagesOutputRel, currentRun: current });
    // The old run's directory, as one.
    expect(outcome).toEqual({ runsKept: 2, runsRemoved: 0, unownedRemoved: 1 });
    expect(existsSync(inRun("run-old"))).toBe(false);
    expect(existsSync(abs(stateDir, "export", "allure-results", "run-old-0-result.json"))).toBe(false);
    expect(existsSync(inRun("run-young", "scenarios", "scn-run-young-0"))).toBe(true);
    expect(existsSync(abs(stateDir, "export", "allure-results", "run-young-0-result.json"))).toBe(true);
    expect(existsSync(runResultPath(rootDir, stateDir, "run-new"))).toBe(true);
  });

  it("never removes the run that applies retention, however many newer runs ended", async () => {
    await seedRun("run-self", "2026-09-01T00:00:00Z");
    await seedRun("run-newer", "2026-09-01T06:00:00Z");

    const outcome = await applyRetention({
      rootDir,
      stateDir,
      policy: { runs: 1, adHocDays: 7 },
      now,
      messagesOutputRel,
      currentRun: { runId: "run-self", startedAt: Date.parse("2026-09-01T00:00:00Z") },
    });
    expect(outcome.runsRemoved).toBe(0);
    expect(existsSync(inRun("run-self"))).toBe(true);
  });

  it("removes a nuka do record once it is older than adHocDays, and keeps a younger one", async () => {
    await seedRun("run-a", "2026-09-01T00:00:00Z");
    await seedDoStep("step-old-do", "2026-08-20T00:00:00Z");
    await seedDoStep("step-new-do", "2026-09-01T00:00:00Z");

    const outcome = await applyRetention({ rootDir, stateDir, policy, now, messagesOutputRel, currentRun: current });
    expect(outcome).toEqual({ runsKept: 2, runsRemoved: 0, unownedRemoved: 1 });
    expect(existsSync(abs(stateDir, "do", "step-old-do"))).toBe(false);
    expect(existsSync(abs(stateDir, "do", "step-new-do"))).toBe(true);
    expect(formatRetention(outcome, policy)).toBe(
      "retention: removed 1 unfinished run or nuka do record older than 7 days (retention.adHocDays)",
    );
  });

  it("dates a run directory without a run.json by mtime, and removes the manifest's export files with it", async () => {
    const old = new Date("2026-08-01T00:00:00Z");
    const resultsDir = abs(stateDir, "export", "allure-results");
    await mkdir(resultsDir, { recursive: true });
    await writeFile(path.join(resultsDir, "crashed-result.json"), "{}");
    const manifestPath = runExportsManifestPath(rootDir, stateDir, "run-crashed");
    await mkdir(inRun("run-crashed", "steps", "step-crashed"), { recursive: true });
    await writeFile(inRun("run-crashed", "steps", "step-crashed", "record.json"), "not json");
    await writeFile(manifestPath, `${path.join(stateDir, "export", "allure-results", "crashed-result.json")}\n`);
    await utimes(inRun("run-crashed"), old, old);
    const brokenDo = abs(stateDir, "do", "step-broken");
    await mkdir(brokenDo, { recursive: true });
    await writeFile(path.join(brokenDo, "record.json"), "not json");
    await utimes(brokenDo, old, old);

    const outcome = await applyRetention({ rootDir, stateDir, policy, now, messagesOutputRel, currentRun: current });
    expect(outcome.unownedRemoved).toBe(2);
    expect(existsSync(inRun("run-crashed"))).toBe(false);
    expect(existsSync(path.join(resultsDir, "crashed-result.json"))).toBe(false);
    expect(existsSync(brokenDo)).toBe(false);
  });

  it("never removes an export file through a manifest line that points outside the project", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "nukadoko-retention-outside-"));
    try {
      const victim = path.join(outside, "keep.json");
      await writeFile(victim, "{}");
      const old = new Date("2026-08-01T00:00:00Z");
      const manifestPath = runExportsManifestPath(rootDir, stateDir, "run-hostile");
      await mkdir(path.dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, `${path.relative(rootDir, victim)}\n`);
      await utimes(path.dirname(manifestPath), old, old);

      await applyRetention({ rootDir, stateDir, policy, now, messagesOutputRel, currentRun: current });
      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("says nothing when nothing was removed", async () => {
    await seedRun("run-a", "2026-09-01T00:00:00Z");
    const outcome = await applyRetention({ rootDir, stateDir, policy, now, messagesOutputRel, currentRun: current });
    expect(formatRetention(outcome, policy)).toBeNull();
  });
});

describe("nuka run applies retention", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("pure-step-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig } from "./nukadoko-shim.js";\n\nexport default defineConfig({ retention: { runs: 1 }, allure: {}, messages: {} });\n',
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("keeps only the newest run's directory and export files, and says what it removed", async () => {
    const first = createCaptureSink();
    expect(await runCli(["run", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: first })).toBe(0);
    expect(first.text()).not.toContain("retention:");

    const second = createCaptureSink();
    expect(await runCli(["run", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: second })).toBe(0);
    expect(second.text()).toContain("retention: removed 1 run older than the newest 1 (retention.runs)");

    const { readdirSync } = await import("node:fs");
    const kept = latestRunJson(rootDir).scenarios.flatMap((scenario: { steps: { step_record_id: string }[] }) =>
      scenario.steps.map((step) => step.step_record_id),
    );
    expect(stepRecordIds(rootDir)).toEqual(kept.sort());
    const runs = readdirSync(path.join(rootDir, ".nukadoko", "runs"));
    expect(runs.length).toBe(1);
    const results = readdirSync(path.join(rootDir, ".nukadoko", "export", "allure-results")).filter((name) =>
      name.endsWith("-result.json"),
    );
    expect(results.length).toBe(1);
    const messages = readdirSync(path.join(rootDir, ".nukadoko", "export")).filter((name) => name.startsWith("messages.run-"));
    expect(messages.length).toBe(1);
  });

  it("removes an older run's messages stream from where that run wrote it, after messages.output moved", async () => {
    expect(await runCli(["run", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: createCaptureSink() })).toBe(0);
    const exportDir = path.join(rootDir, ".nukadoko", "export");
    expect(readdirSync(exportDir).filter((name) => name.startsWith("messages.run-"))).toHaveLength(1);

    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig } from "./nukadoko-shim.js";\n\n' +
        'export default defineConfig({ retention: { runs: 1 }, allure: {}, messages: { output: "reports/messages.ndjson" } });\n',
    );
    // A separate process: this one has already loaded and kept the first config.
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const { stderr } = await promisify(execFile)(
      process.execPath,
      [...sourceNodeArgs, path.join(repoRoot, "src", "cli.ts"), "run", "features/greeting.feature"],
      { cwd: rootDir },
    );
    expect(stderr).toContain("retention: removed 1 run older than the newest 1 (retention.runs)");

    expect(readdirSync(exportDir).filter((name) => name.startsWith("messages.run-"))).toEqual([]);
    expect(readdirSync(path.join(rootDir, "reports")).filter((name) => name.startsWith("messages.run-"))).toHaveLength(1);
  });
});

describe("nuka run --concurrency applies retention", () => {
  let rootDir: string;
  const resultsDir = (root: string): string => path.join(root, ".nukadoko", "export", "allure-results");
  const runFiles = (root: string): string[] =>
    readdirSync(resultsDir(root))
      .filter((name) => name !== "environment.properties" && name !== "categories.json")
      .map((name) => path.join(".nukadoko", "export", "allure-results", name))
      .sort();

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-concurrency-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig } from "./nukadoko-shim.js";\n\nexport default defineConfig({ retention: { runs: 1 }, allure: {}, messages: {} });\n',
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("collects every export file the worker processes wrote into the run's manifest, and prunes them by it next run", async () => {
    // The parent never sees the names a worker's writer chose, so the
    // manifest is the only account of them. Fresh directory: every file
    // under allure-results/ except the two shared ones is this run's.
    const first = createCaptureSink();
    expect(
      await runCli(["run", "features/basic/", "--concurrency", "2"], { rootDir, stdout: createCaptureSink(), stderr: first }),
      first.text(),
    ).toBe(0);
    const runsDir = path.join(rootDir, ".nukadoko", "runs");
    const [firstRunId] = readdirSync(runsDir);
    expect(readdirSync(runsDir)).toHaveLength(1);
    const firstManifest = readExportsManifest(path.join(runsDir, firstRunId!, "exports"));
    expect([...firstManifest].sort()).toEqual(
      [...runFiles(rootDir), path.join(".nukadoko", "export", `messages.${firstRunId}.ndjson`)].sort(),
    );
    const resultFiles = firstManifest.filter((name) => name.endsWith("-result.json"));
    expect(resultFiles).toHaveLength(2);
    const resultTexts = resultFiles.map((relative) => readFileSync(path.join(rootDir, relative), "utf8"));
    expect(resultTexts.some((text) => text.includes("features/basic/a.feature"))).toBe(true);
    expect(resultTexts.some((text) => text.includes("features/basic/b.feature"))).toBe(true);

    const second = createCaptureSink();
    expect(
      await runCli(["run", "features/basic/", "--concurrency", "2"], { rootDir, stdout: createCaptureSink(), stderr: second }),
      second.text(),
    ).toBe(0);
    expect(second.text()).toContain("retention: removed 1 run older than the newest 1 (retention.runs)");
    for (const relative of firstManifest) {
      expect(existsSync(path.join(rootDir, relative)), relative).toBe(false);
    }
    expect(existsSync(path.join(runsDir, firstRunId!))).toBe(false);
    expect(readdirSync(runsDir)).toHaveLength(1);
    const kept = latestRunJson(rootDir).scenarios.flatMap((scenario: { steps: { step_record_id: string }[] }) =>
      scenario.steps.map((step) => step.step_record_id),
    );
    expect(stepRecordIds(rootDir)).toEqual(kept.sort());
    expect(existsSync(path.join(resultsDir(rootDir), "environment.properties"))).toBe(true);
  });
});
