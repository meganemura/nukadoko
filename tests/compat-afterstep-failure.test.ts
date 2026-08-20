import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: an AfterStep hook's own failure (throw). tests/compat-
// afterstep.test.ts already covers a passing AfterStep end to end, but
// never one that fails. AfterStep's own non-breaking failure handling
// (src/run/run-scenario.ts's `runAfterStepHooks`, mirroring the After
// loop): a sibling AfterStep hook still runs for the same step, the step
// that just ran keeps its own real status, and only the rest of the
// scenario is skipped from there on. Against tests/fixtures/compat-
// afterstep-project, whose own untagged AfterStep hook (features/steps/
// steps.ts) applies here too, alongside the new tagged, throwing one.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

interface HookRecord {
  readonly type: string;
  readonly status: string;
  readonly step_index?: number;
  readonly error?: { readonly message: string; readonly kind: string };
  readonly declared?: { readonly logs?: readonly string[] };
}

describe("nuka run: AfterStep hook failure", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-afterstep-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fails the hook's own entry, leaves the step's status alone, and skips the rest of the scenario", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/afterstep-failure.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps).toHaveLength(2);
    // The step this hook followed still passed on its own merits: a
    // hook's own failure never rewrites the step's own outcome.
    expect(record.steps[0].status).toBe("passed");
    expect(record.steps[1].status).toBe("skipped");

    const afterStepHooks: HookRecord[] = record.hooks.filter((h: HookRecord) => h.type === "after_step");
    // Both the tagged (throwing) hook and the project's own untagged one
    // ran for step 0: the throwing one does not stop its sibling.
    expect(afterStepHooks).toHaveLength(2);
    const failed = afterStepHooks.find((h) => h.status === "failed");
    const ok = afterStepHooks.find((h) => h.status === "ok");
    expect(failed).toBeDefined();
    expect(failed!.step_index).toBe(0);
    expect(failed!.error?.message).toContain("afterstep hook exploded on purpose");
    // An ordinary throw, not one of the shapes classified `timeout`/
    // `world_invalid`/`unsupported`.
    expect(failed!.error?.kind).toBe("step_error");
    expect(ok).toBeDefined();
    expect(ok!.step_index).toBe(0);
  });
});
