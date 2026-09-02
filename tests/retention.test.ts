import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { runCli } from "../src/cli/run-cli.js";
import { messagesRunOutputPath } from "../src/report/messages/emitter.js";
import {
  applyRetention,
  formatRetention,
  planAgeRetention,
  planRunRetention,
  type RunSummary,
} from "../src/record/retention.js";
import { readExportsManifest, runExportsManifestPath } from "../src/record/run-exports.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

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

  /** One run: `count` scenario records, each citing one step record, one
   * manifest naming one export file per scenario, and one messages stream. */
  async function seedRun(runId: string, startedAt: string, count = 1): Promise<void> {
    const resultsDir = abs(stateDir, "export", "allure-results");
    await mkdir(resultsDir, { recursive: true });
    const manifestPath = runExportsManifestPath(rootDir, stateDir, runId);
    await mkdir(path.dirname(manifestPath), { recursive: true });
    const manifestLines: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const scenarioId = `scn-${runId}-${index}`;
      const stepId = `step-${runId}-${index}`;
      await mkdir(abs(stateDir, "records", "scenarios", scenarioId), { recursive: true });
      await writeFile(
        abs(stateDir, "records", "scenarios", scenarioId, "record.json"),
        JSON.stringify({
          scenario_record_id: scenarioId,
          run_id: runId,
          started_at: startedAt,
          finished_at: startedAt,
          steps: [{ text: "x", status: "passed", step_record_id: stepId }],
        }),
      );
      await mkdir(abs(stateDir, "records", "steps", stepId), { recursive: true });
      await writeFile(abs(stateDir, "records", "steps", stepId, "record.json"), JSON.stringify({ run_id: runId }));
      const exportFile = path.join(stateDir, "export", "allure-results", `${runId}-${index}-result.json`);
      await writeFile(abs(exportFile), "{}");
      manifestLines.push(exportFile);
    }
    await writeFile(manifestPath, `${manifestLines.join("\n")}\n`);
    await writeFile(messagesRunOutputPath(abs(messagesOutputRel), runId), "line\n");
  }

  async function seedAdHocStep(stepId: string, finishedAt: string): Promise<void> {
    await mkdir(abs(stateDir, "records", "steps", stepId), { recursive: true });
    await writeFile(
      abs(stateDir, "records", "steps", stepId, "record.json"),
      JSON.stringify({ run_id: null, started_at: finishedAt, finished_at: finishedAt }),
    );
  }

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-retention-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("removes every run older than the newest `runs`, with its records, export files, and messages stream", async () => {
    await seedRun("run-a", "2026-09-01T00:00:00Z", 2);
    await seedRun("run-b", "2026-09-01T06:00:00Z");
    await seedRun("run-c", "2026-09-01T12:00:00Z");
    // A shared file: written by every run, listed by none.
    await writeFile(abs(stateDir, "export", "allure-results", "environment.properties"), "x=y\n");

    const outcome = await applyRetention({ rootDir, stateDir, policy, now, messagesOutputRel });
    expect(outcome).toEqual({ skipped: null, runsKept: 2, runsRemoved: 1, unownedRemoved: 0 });

    for (const gone of [
      abs(stateDir, "records", "scenarios", "scn-run-a-0"),
      abs(stateDir, "records", "scenarios", "scn-run-a-1"),
      abs(stateDir, "records", "steps", "step-run-a-0"),
      abs(stateDir, "records", "steps", "step-run-a-1"),
      abs(stateDir, "export", "allure-results", "run-a-0-result.json"),
      abs(stateDir, "export", "allure-results", "run-a-1-result.json"),
      messagesRunOutputPath(abs(messagesOutputRel), "run-a"),
      abs(stateDir, "records", "runs", "run-a"),
    ]) {
      expect(existsSync(gone), gone).toBe(false);
    }
    for (const kept of [
      abs(stateDir, "records", "scenarios", "scn-run-b-0"),
      abs(stateDir, "records", "steps", "step-run-c-0"),
      abs(stateDir, "export", "allure-results", "run-b-0-result.json"),
      abs(stateDir, "export", "allure-results", "run-c-0-result.json"),
      abs(stateDir, "export", "allure-results", "environment.properties"),
      messagesRunOutputPath(abs(messagesOutputRel), "run-c"),
      runExportsManifestPath(rootDir, stateDir, "run-b"),
    ]) {
      expect(existsSync(kept), kept).toBe(true);
    }
    expect(formatRetention(outcome, policy)).toBe("retention: removed 1 run older than the newest 2 (retention.runs)");
  });

  it("dates a run by its earliest scenario, so a long run that began first is the older one", async () => {
    await seedRun("run-long", "2026-09-01T00:00:00Z");
    // A second scenario of the long run finished after the short run began.
    await mkdir(abs(stateDir, "records", "scenarios", "scn-long-late"), { recursive: true });
    await writeFile(
      abs(stateDir, "records", "scenarios", "scn-long-late", "record.json"),
      JSON.stringify({ scenario_record_id: "scn-long-late", run_id: "run-long", started_at: "2026-09-01T02:00:00Z", steps: [] }),
    );
    await seedRun("run-short", "2026-09-01T01:00:00Z");

    const outcome = await applyRetention({ rootDir, stateDir, policy: { runs: 1, adHocDays: 7 }, now, messagesOutputRel });
    expect(outcome.runsRemoved).toBe(1);
    expect(existsSync(abs(stateDir, "records", "scenarios", "scn-run-short-0"))).toBe(true);
    expect(existsSync(abs(stateDir, "records", "scenarios", "scn-long-late"))).toBe(false);
  });

  it("removes a record no retained run owns once it is older than adHocDays, and keeps a younger one", async () => {
    await seedRun("run-a", "2026-09-01T00:00:00Z");
    await seedAdHocStep("step-old-do", "2026-08-20T00:00:00Z");
    await seedAdHocStep("step-new-do", "2026-09-01T00:00:00Z");

    const outcome = await applyRetention({ rootDir, stateDir, policy, now, messagesOutputRel });
    expect(outcome).toEqual({ skipped: null, runsKept: 1, runsRemoved: 0, unownedRemoved: 1 });
    expect(existsSync(abs(stateDir, "records", "steps", "step-old-do"))).toBe(false);
    expect(existsSync(abs(stateDir, "records", "steps", "step-new-do"))).toBe(true);
    expect(formatRetention(outcome, policy)).toBe(
      "retention: removed 1 record no retained run owns, older than 7 days (retention.adHocDays)",
    );
  });

  it("dates an unreadable scenario directory and a manifest without scenarios by mtime, and removes the manifest's export files with it", async () => {
    const old = new Date("2026-08-01T00:00:00Z");
    const brokenDir = abs(stateDir, "records", "scenarios", "scn-broken");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(path.join(brokenDir, "record.json"), "not json");
    await utimes(brokenDir, old, old);

    const resultsDir = abs(stateDir, "export", "allure-results");
    await mkdir(resultsDir, { recursive: true });
    await writeFile(path.join(resultsDir, "crashed-result.json"), "{}");
    const manifestPath = runExportsManifestPath(rootDir, stateDir, "run-crashed");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${path.join(stateDir, "export", "allure-results", "crashed-result.json")}\n`);
    await utimes(path.dirname(manifestPath), old, old);

    const outcome = await applyRetention({ rootDir, stateDir, policy, now, messagesOutputRel });
    expect(outcome.unownedRemoved).toBe(2);
    expect(existsSync(brokenDir)).toBe(false);
    expect(existsSync(path.join(resultsDir, "crashed-result.json"))).toBe(false);
    expect(existsSync(path.dirname(manifestPath))).toBe(false);
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

      await applyRetention({ rootDir, stateDir, policy, now, messagesOutputRel });
      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("skips everything, and says which session, while a session is live", async () => {
    await seedRun("run-a", "2026-09-01T00:00:00Z");
    await seedRun("run-b", "2026-09-01T01:00:00Z");
    await seedRun("run-c", "2026-09-01T02:00:00Z");
    // A live session is a `nuka session start` daemon: a lock whose pid is
    // alive *and* whose socket exists (src/live/live-session-notice.ts). A
    // lock without a socket is a `nuka do --session`/`nuka run --session`
    // holding its name for the length of one command, and that one is
    // the invocation running retention itself.
    const sessionsDir = abs(stateDir, "cache", "sessions", "default");
    await mkdir(sessionsDir, { recursive: true });
    const sock = path.join(sessionsDir, "alpha.sock");
    await writeFile(sock, "");
    await writeFile(
      path.join(sessionsDir, "alpha.lock"),
      JSON.stringify({ pid: process.pid, started_at: now.toISOString(), sock }),
    );

    const outcome = await applyRetention({ rootDir, stateDir, policy, now, messagesOutputRel });
    expect(outcome.skipped?.liveSessions.map((session) => session.name)).toEqual(["alpha"]);
    expect(existsSync(abs(stateDir, "records", "scenarios", "scn-run-a-0"))).toBe(true);
    expect(formatRetention(outcome, policy)).toContain('session "alpha" (environment "default") is live');
  });

  it("says nothing when nothing was removed", async () => {
    await seedRun("run-a", "2026-09-01T00:00:00Z");
    const outcome = await applyRetention({ rootDir, stateDir, policy, now, messagesOutputRel });
    expect(formatRetention(outcome, policy)).toBeNull();
  });
});

describe("nuka run applies retention", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig } from "./nukadoko-shim.js";\n\nexport default defineConfig({ retention: { runs: 1 } });\n',
    );
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("keeps only the newest run's records and export files, and says what it removed", async () => {
    const first = createCaptureSink();
    expect(await runCli(["run", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: first })).toBe(0);
    expect(first.text()).not.toContain("retention:");

    const second = createCaptureSink();
    expect(await runCli(["run", "features/greeting.feature"], { rootDir, stdout: createCaptureSink(), stderr: second })).toBe(0);
    expect(second.text()).toContain("retention: removed 1 run older than the newest 1 (retention.runs)");

    const { readdirSync } = await import("node:fs");
    const scenarios = readdirSync(path.join(rootDir, ".nukadoko", "records", "scenarios"));
    expect(scenarios.length).toBe(1);
    const runs = readdirSync(path.join(rootDir, ".nukadoko", "records", "runs"));
    expect(runs.length).toBe(1);
    const results = readdirSync(path.join(rootDir, ".nukadoko", "export", "allure-results")).filter((name) =>
      name.endsWith("-result.json"),
    );
    expect(results.length).toBe(1);
    const messages = readdirSync(path.join(rootDir, ".nukadoko", "export")).filter((name) => name.startsWith("messages.run-"));
    expect(messages.length).toBe(1);
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
      'import { defineConfig } from "./nukadoko-shim.js";\n\nexport default defineConfig({ retention: { runs: 1 } });\n',
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
    const runsDir = path.join(rootDir, ".nukadoko", "records", "runs");
    const [firstRunId] = readdirSync(runsDir);
    expect(readdirSync(runsDir)).toHaveLength(1);
    const firstManifest = readExportsManifest(path.join(runsDir, firstRunId!, "exports"));
    expect([...firstManifest].sort()).toEqual(runFiles(rootDir));
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
    expect(readdirSync(path.join(rootDir, ".nukadoko", "records", "scenarios"))).toHaveLength(2);
    expect(existsSync(path.join(resultsDir(rootDir), "environment.properties"))).toBe(true);
  });
});
