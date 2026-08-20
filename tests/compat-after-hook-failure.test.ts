import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: an After hook's own failure (throw). tests/compat-
// execution.test.ts already covers a Before hook failing (timeout/pending/
// done-callback) but never an After hook. After's own non-breaking failure
// handling (src/run/run-scenario.ts): a throw here still lets the scenario
// record get written, failed, with the step's own real status untouched.
// Against tests/fixtures/compat-execution-project, whose own untagged
// Before/After hooks (features/steps/hooks.ts) apply here too, alongside
// the new tagged, throwing After hook.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

interface HookRecord {
  readonly type: string;
  readonly status: string;
  readonly error?: { readonly message: string; readonly kind: string };
}

describe("nuka run: After hook failure", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-execution-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fails the scenario, but the step's own status and the scenario record survive the hook's own throw", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/after-hook-failure.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    // The step itself ran clean: only the After hook that followed it
    // failed.
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0].status).toBe("passed");

    const afterHooks: HookRecord[] = record.hooks.filter((h: HookRecord) => h.type === "after");
    // The project's own untagged After hook and the new tagged, throwing
    // one both ran: the throwing one does not stop its sibling.
    expect(afterHooks).toHaveLength(2);
    const failed = afterHooks.find((h) => h.status === "failed");
    const ok = afterHooks.find((h) => h.status === "ok");
    expect(failed).toBeDefined();
    expect(failed!.error?.message).toContain("after hook exploded on purpose");
    expect(failed!.error?.kind).toBe("step_error");
    expect(ok).toBeDefined();
  });
});
