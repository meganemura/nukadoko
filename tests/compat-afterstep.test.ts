import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: t7-compat-status-afterstep task spec's coverage for
// `AfterStep` execution (registration-shape coverage — the three call forms
// — lives in tests/compat-hooks.test.ts, alongside Before/After's own) —
// runs once per executed pickle step, never after a step this scenario
// skipped, `record.hooks[]` entries carry `type: "after_step"` and the
// right `step_index`, and the tag filter/`HookParameter.result` both work
// the same way Before/After's already do. Against
// tests/fixtures/compat-afterstep-project.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

interface HookRecord {
  readonly type: string;
  readonly status: string;
  readonly step_index?: number;
  readonly declared?: { readonly logs?: readonly string[] };
}

describe("nuka run: AfterStep hook execution", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-afterstep-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("runs once per executed step, with the right step_index and result.status each time", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/afterstep.feature:3"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps).toHaveLength(2);

    const afterStepHooks: HookRecord[] = record.hooks.filter((h: HookRecord) => h.type === "after_step");
    // One AfterStep entry per executed step — count matches the number of
    // steps that actually ran, not the number of hooks registered.
    expect(afterStepHooks).toHaveLength(2);
    expect(afterStepHooks.map((h) => h.step_index)).toEqual([0, 1]);
    for (const hook of afterStepHooks) {
      expect(hook.status).toBe("ok");
      expect(hook.declared?.logs).toContain("afterstep:status=PASSED");
      expect(hook.declared?.logs).toContain("afterstep:statusFailedMatches=false");
    }
  });

  it('does not run after a step this scenario skipped ("skipped step は実行されておらず、後が存在しない")', async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/afterstep.feature:7"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(2);
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[1].status).toBe("skipped");

    const afterStepHooks: HookRecord[] = record.hooks.filter((h: HookRecord) => h.type === "after_step");
    // Only the failed (but executed) first step got an AfterStep entry — the
    // skipped second step got none at all.
    expect(afterStepHooks).toHaveLength(1);
    expect(afterStepHooks[0]!.step_index).toBe(0);
    expect(afterStepHooks[0]!.declared?.logs).toContain("afterstep:status=FAILED");
    // The step's own result, not the (also-failed) scenario's, reaches the
    // hook — but for this fixture the two happen to agree, since this is
    // the step that made the scenario fail in the first place.
    expect(afterStepHooks[0]!.declared?.logs).toContain("afterstep:statusFailedMatches=true");
  });

  it("tag filter: the @slow-tagged AfterStep only runs for the @slow-tagged scenario", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/afterstep.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    // The whole run's own exit code reflects the "a failing step skips the
    // rest" scenario elsewhere in this same file failing on purpose (its own
    // test above) — this test only cares about the other two scenarios.
    expect(exitCode).toBe(1);
    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    const tagged = records.find((r) => r.scenario === "a tagged scenario");
    const untagged = records.find((r) => r.scenario === "an untagged scenario");
    expect(tagged).toBeDefined();
    expect(untagged).toBeDefined();

    const taggedAfterStep: HookRecord[] = tagged.hooks.filter((h: HookRecord) => h.type === "after_step");
    // Untagged hook (+1) and the @slow-tagged hook (+1) both apply.
    expect(taggedAfterStep).toHaveLength(2);
    expect(taggedAfterStep.some((h) => h.declared?.logs?.includes("afterstep:tagged=ran"))).toBe(true);

    const untaggedAfterStep: HookRecord[] = untagged.hooks.filter((h: HookRecord) => h.type === "after_step");
    // Only the untagged hook applies — the @slow-tagged one does not.
    expect(untaggedAfterStep).toHaveLength(1);
    expect(untaggedAfterStep.some((h) => h.declared?.logs?.includes("afterstep:tagged=ran"))).toBe(false);
  });
});
