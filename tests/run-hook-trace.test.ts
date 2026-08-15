import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: p3d-hook-trace task spec's own end-to-end coverage —
// p3a-trace-per-step cut the Playwright trace into one chunk per step,
// which silently stopped recording anything a Before/After/AfterStep hook
// did through `ctx.page()`/`this.openPage()` (this task's spec's own "why").
// This file proves the fix against a real `nuka run` + real Playwright
// browser, against tests/fixtures/run-hook-trace-project: a Before hook, an
// AfterStep hook, and an After hook (which never touches the browser at
// all) sit around a 2-step scenario where each step also touches the
// browser, every one of them navigating to its own "data:" URL marker so a
// chunk mixing two invocations' operations together is directly observable
// via each chunk's own `actions[].url`.

interface HookRecord {
  readonly type: string;
  readonly status: string;
  readonly step_index?: number;
  readonly trace?: string;
  readonly actions?: ReadonlyArray<{ readonly url?: string }>;
}

interface StoredStepRecord {
  readonly actions?: ReadonlyArray<{ readonly url?: string }>;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

async function readStepRecord(rootDir: string, recordId: string): Promise<StoredStepRecord> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8")) as StoredStepRecord;
}

function actionUrls(actions: ReadonlyArray<{ readonly url?: string }> | undefined): string[] {
  return (actions ?? []).map((action) => action.url).filter((url): url is string => url !== undefined);
}

describe("nuka run (hook trace chunks)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("run-hook-trace-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("gives each Before/AfterStep hook invocation its own trace chunk, isolated from steps and each other, and none to a hook that never touches the browser", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/hook-trace.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(stripRunProgressLines(stderr.text())).toBe("");

    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(2);

    const scenarioDir = path.join(rootDir, record.evidence.dir as string);
    const hooks: HookRecord[] = record.hooks;

    // --- test item 1: Before hook's own trace, contents isolated ---
    const beforeHook = hooks.find((h) => h.type === "before");
    expect(beforeHook).toBeDefined();
    expect(beforeHook!.trace).toBeDefined();
    expect(existsSync(path.join(scenarioDir, beforeHook!.trace!))).toBe(true);
    expect(actionUrls(beforeHook!.actions)).toEqual(["data:text/html,before-hook"]);

    // --- test item 3: a hook that never touches the browser gets no trace ---
    const afterHook = hooks.find((h) => h.type === "after");
    expect(afterHook).toBeDefined();
    expect(afterHook!.trace).toBeUndefined();
    expect(Object.keys(afterHook!)).not.toContain("trace");
    expect(afterHook!.actions).toBeUndefined();

    // --- test item 2: AfterStep runs twice, 2 separate chunks, keyed by step_index ---
    const afterStepHooks = hooks.filter((h) => h.type === "after_step");
    expect(afterStepHooks).toHaveLength(2);
    expect(afterStepHooks.map((h) => h.step_index)).toEqual([0, 1]);
    expect(afterStepHooks[0]!.trace).toBeDefined();
    expect(afterStepHooks[1]!.trace).toBeDefined();
    expect(afterStepHooks[0]!.trace).not.toBe(afterStepHooks[1]!.trace);
    for (const hook of afterStepHooks) {
      expect(existsSync(path.join(scenarioDir, hook.trace!))).toBe(true);
      // --- test item 5 (hook side): only its own navigation, never a step's ---
      expect(actionUrls(hook.actions)).toEqual(["data:text/html,after-step-hook"]);
    }

    // --- test item 5 (step side): a step's own chunk carries none of the
    // hooks' operations, only its own. ---
    const step1 = await readStepRecord(rootDir, record.steps[0].record as string);
    const step2 = await readStepRecord(rootDir, record.steps[1].record as string);
    expect(actionUrls(step1.actions)).toEqual(["data:text/html,step-one"]);
    expect(actionUrls(step2.actions)).toEqual(["data:text/html,step-two"]);

    // Every chunk file this scenario wrote is distinct — the isolation above
    // is real separation on disk, not several record entries pointing at
    // one shared file.
    const allTraceFiles = [
      beforeHook!.trace!,
      afterStepHooks[0]!.trace!,
      afterStepHooks[1]!.trace!,
    ];
    expect(new Set(allTraceFiles).size).toBe(allTraceFiles.length);
  });
});
