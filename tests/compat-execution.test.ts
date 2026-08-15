import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

async function readStepRecord(rootDir: string, recordId: string): Promise<Record<string, unknown>> {
  const recordPath = path.join(rootDir, ".nukadoko", "records", "steps", recordId, "record.json");
  return JSON.parse(await readFile(recordPath, "utf8"));
}

// Responsibility: m21b-compat-execution task spec's coverage for the
// execution-time "silent behavior change" closures — a compat step's/hook's
// own `{ timeout }` is actually enforced (items 1-2), Before/After hooks
// receive a real `HookParameter` instead of zero arguments (item 3), a
// string return of `"pending"`/`"skipped"` fails loudly instead of quietly
// passing (item 4), and an apparent `done`-callback arity fails loudly
// instead of hanging (item 5). All against tests/fixtures/compat-execution-
// project, whose steps/hooks are laid out in this same order.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("nuka run: compat step/hook execution honesty", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-execution-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  describe("step timeout enforcement (item 2)", () => {
    it("a step exceeding its own timeout fails at the configured value, not at how long it actually runs, and the scenario moves on", async () => {
      const stdout = createCaptureSink();
      const startedAt = Date.now();
      const exitCode = await runCli(["run", "features/step-timeout.feature:3"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });
      const elapsedMs = Date.now() - startedAt;

      expect(exitCode).toBe(1);
      // The glue's own sleep is 30000ms; a run that actually waited for it
      // would take at least that long. This bound only has to be far below
      // that and far above ordinary CLI/discovery overhead, so what it
      // proves is that the 20ms timeout — not the glue's own duration — is
      // what this scenario waited on. The bound was 3000ms against a 5000ms
      // sleep until a full `vitest run` measured 3332ms here under parallel
      // load: the fix is a wider gap, not a threshold creeping toward the
      // sleep it is supposed to be distinguishable from.
      expect(elapsedMs).toBeLessThan(10_000);

      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      expect(record.status).toBe("failed");
      expect(record.steps[0].status).toBe("failed");
      expect(record.steps[0].error.message).toContain("timed out after 20ms");
      // Identified by type (`CompatTimeoutError`), never by matching "timed
      // out" in the message — distinct from "step_error" (an ordinary throw
      // from the same step shape).
      const stepRecord = await readStepRecord(rootDir, record.steps[0].record);
      expect(stepRecord.error).toMatchObject({ kind: "timeout" });

      // The scenario didn't hang on the timed-out step: the next step in
      // the same pickle still got its own record entry (skipped, since the
      // first step already failed).
      expect(record.steps[1].status).toBe("skipped");
      expect(record.steps[1].record).toBeNull();
    });

    it("a step finishing well within its own timeout succeeds and clears its own race timer immediately (no leaked Node timer)", async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      try {
        const stdout = createCaptureSink();
        const exitCode = await runCli(["run", "features/step-timeout.feature:7"], {
          rootDir,
          stdout,
          stderr: createCaptureSink(),
        });

        expect(exitCode).toBe(0);
        const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
        expect(record.status).toBe("passed");

        // 12345ms is this step's own distinctive `{ timeout }` value
        // (tests/fixtures/compat-execution-project/features/steps/timeout-
        // glue.ts) — find *its* race timer among whatever else this `nuka
        // run` invocation also scheduled with `setTimeout`, and confirm it
        // was cleared rather than left pending for the full 12345ms.
        const raceTimerCallIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 12_345);
        expect(raceTimerCallIndex).toBeGreaterThanOrEqual(0);
        const timerHandle = setTimeoutSpy.mock.results[raceTimerCallIndex]!.value;
        expect(clearTimeoutSpy.mock.calls.some((call) => call[0] === timerHandle)).toBe(true);
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });
  });

  describe('"pending"/"skipped" returns are not interpreted (item 4)', () => {
    it('a step returning "pending" fails with a readable message pointing at docs/migration.md', async () => {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/step-pending-skip.feature:3"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      expect(record.steps[0].status).toBe("failed");
      expect(record.steps[0].error.message).toContain('"pending"');
      expect(record.steps[0].error.message).toContain("docs/migration.md");
      // A compat-only shape nukadoko doesn't implement classifies as
      // "unsupported", never "step_error" (this is set directly at the
      // point it's detected, not thrown/caught).
      const stepRecord = await readStepRecord(rootDir, record.steps[0].record);
      expect(stepRecord.error).toMatchObject({ kind: "unsupported" });
    });

    it('a step returning "skipped" fails with a readable message pointing at docs/migration.md', async () => {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/step-pending-skip.feature:6"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      expect(record.steps[0].status).toBe("failed");
      expect(record.steps[0].error.message).toContain('"skipped"');
      expect(record.steps[0].error.message).toContain("docs/migration.md");
      const stepRecord = await readStepRecord(rootDir, record.steps[0].record);
      expect(stepRecord.error).toMatchObject({ kind: "unsupported" });
    });
  });

  describe("done-callback form is not supported (item 5)", () => {
    it("a step expecting a done callback fails instead of hanging, with a readable message", async () => {
      const stdout = createCaptureSink();
      const startedAt = Date.now();
      const exitCode = await runCli(["run", "features/step-done-callback.feature"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });
      const elapsedMs = Date.now() - startedAt;

      expect(exitCode).toBe(1);
      // No timeout is configured on this step at all — a run that actually
      // called it and waited on `done()` (never invoked with the right
      // signature) would hang indefinitely. The comparison here is against
      // "forever", so the bound can be loose enough to survive parallel-
      // worker load without weakening what it proves.
      expect(elapsedMs).toBeLessThan(10_000);

      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      expect(record.steps[0].status).toBe("failed");
      expect(record.steps[0].error.message).toContain("done()");
      expect(record.steps[0].error.message).toContain("docs/migration.md");
      const stepRecord = await readStepRecord(rootDir, record.steps[0].record);
      expect(stepRecord.error).toMatchObject({ kind: "unsupported" });
    });
  });

  describe("hook timeout / done-callback / pending (items 1, 2, 4, 5 applied to hooks)", () => {
    it("a Before hook exceeding its own timeout fails at the configured value, skipping this scenario's step", async () => {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/hook-timeout.feature:4"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      expect(record.status).toBe("failed");

      const beforeHooks = record.hooks.filter((h: { type: string }) => h.type === "before");
      const failedBefore = beforeHooks.find((h: { status: string }) => h.status === "failed");
      expect(failedBefore).toBeDefined();
      expect(failedBefore.error.message).toContain("timed out after 20ms");
      // A hook has no step record of its own — the same closed enum lands
      // directly on `record.hooks[]`.
      expect(failedBefore.error.kind).toBe("timeout");

      expect(record.steps[0].status).toBe("skipped");
      expect(record.steps[0].record).toBeNull();
    });

    it("a Before hook expecting a done callback fails instead of hanging", async () => {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/hook-done-callback.feature:4"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      const beforeHooks = record.hooks.filter((h: { type: string }) => h.type === "before");
      const failedBefore = beforeHooks.find((h: { status: string }) => h.status === "failed");
      expect(failedBefore).toBeDefined();
      expect(failedBefore.error.message).toContain("done()");
      expect(failedBefore.error.kind).toBe("unsupported");
      expect(record.steps[0].status).toBe("skipped");
    });

    it('a Before hook returning "pending" fails', async () => {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/hook-pending.feature:4"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      const beforeHooks = record.hooks.filter((h: { type: string }) => h.type === "before");
      const failedBefore = beforeHooks.find((h: { status: string }) => h.status === "failed");
      expect(failedBefore).toBeDefined();
      expect(failedBefore.error.message).toContain('"pending"');
      expect(failedBefore.error.kind).toBe("unsupported");
      expect(record.steps[0].status).toBe("skipped");
    });
  });

  describe("HookParameter reaches every hook (item 3)", () => {
    it("Before destructures { gherkinDocument, pickle, testCaseStartedId, willBeRetried } without crashing; the feature's own name is readable", async () => {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/hook-parameter.feature:3"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(0);
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      const before = record.hooks.find((h: { type: string }) => h.type === "before");
      expect(before.status).toBe("ok");
      expect(before.declared.logs).toContain("before:feature=hook parameter coverage");
      expect(before.declared.logs).toContain("before:pickle=a passing scenario");
      // nukadoko's own scenario id, not a cucumber message id — just a
      // non-empty string is what this proves (this task's spec, item 3).
      expect(before.declared.logs).toContain("before:testCaseStartedId=string");
      expect(before.declared.logs).toContain("before:willBeRetried=false");
    });

    it("After receives result.status \"PASSED\" for a passing scenario", async () => {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/hook-parameter.feature:3"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(0);
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      const after = record.hooks.find((h: { type: string }) => h.type === "after");
      expect(after.status).toBe("ok");
      expect(after.declared.logs).toContain("after:result=PASSED");
    });

    it("After receives result.status \"FAILED\" for a failing scenario, using cucumber's own Status string value", async () => {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/hook-parameter.feature:6"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      expect(record.status).toBe("failed");
      const after = record.hooks.find((h: { type: string }) => h.type === "after");
      expect(after.status).toBe("ok");
      expect(after.declared.logs).toContain("after:result=FAILED");
    });
  });

  // t7-compat-status-afterstep task spec, item 1: `nukadoko/compat`'s own
  // `Status` re-export actually works in a real After hook's own
  // `result.status === Status.FAILED` branch — not just that `Status`
  // imports (tests/compat-status.test.ts already covers that in isolation).
  describe("Status (t7-compat-status-afterstep task spec, item 1)", () => {
    it("result.status === Status.FAILED is false for a passing scenario", async () => {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/hook-parameter.feature:3"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(0);
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      const after = record.hooks.find((h: { type: string }) => h.type === "after");
      expect(after.declared.logs).toContain("after:statusFailedMatches=false");
    });

    it("result.status === Status.FAILED is true for a failing scenario", async () => {
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "features/hook-parameter.feature:6"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });

      expect(exitCode).toBe(1);
      const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
      const after = record.hooks.find((h: { type: string }) => h.type === "after");
      expect(after.declared.logs).toContain("after:statusFailedMatches=true");
    });
  });
});
