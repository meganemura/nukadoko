import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { discoverSteps } from "../src/discover/discover-steps.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: m22-compat-run-scope task spec's end-to-end coverage —
// `setDefaultTimeout` (item 1) actually reaching compat step/hook execution
// as a fallback timeout, and `BeforeAll`/`AfterAll` (item 2) actually
// running around `nuka run`'s own scenario loop, once per run, skipped
// entirely for a run selecting zero pickles. Unit-level registration-shape
// coverage lives in tests/compat-run-hooks.test.ts and tests/compat-
// default-timeout.test.ts instead; this file is only about what happens
// once execution reaches src/cli/run.ts / src/run/run-scenario.ts.

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

describe("nuka run: setDefaultTimeout applies to compat steps/hooks", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-default-timeout-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("discoverSteps() surfaces the final defaultTimeoutMs — the second of two setDefaultTimeout calls wins", async () => {
    const { defaultTimeoutMs } = await discoverSteps(rootDir, "features");
    expect(defaultTimeoutMs).toBe(20);
  });

  it("applies to a step with no own timeout: fails at the default value, not the sleep duration", async () => {
    const stdout = createCaptureSink();
    const startedAt = Date.now();
    const exitCode = await runCli(["run", "features/default-timeout-step.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });
    const elapsedMs = Date.now() - startedAt;

    expect(exitCode).toBe(1);
    // The glue's own sleep is 500ms; a run that actually waited for it (or
    // for the first, never-overridden setDefaultTimeout(999999) call) would
    // take far longer than this bound.
    expect(elapsedMs).toBeLessThan(1200);

    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("failed");
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[0].error.message).toContain("timed out after 20ms");
  });

  it("a step's own (larger) timeout overrides the default: the scenario passes", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/step-own-timeout-overrides-default.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
  });

  it("applies to a Before hook with no own timeout: the hook fails at the default value", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/default-timeout-hook.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    const beforeHooks = record.hooks.filter((h: { type: string }) => h.type === "before");
    const failedBefore = beforeHooks.find((h: { status: string }) => h.status === "failed");
    expect(failedBefore).toBeDefined();
    expect(failedBefore.error.message).toContain("timed out after 20ms");
    expect(record.steps[0].status).toBe("skipped");
  });

  it("a Before hook's own (larger) timeout overrides the default: the scenario passes", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/hook-own-timeout-overrides-default.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
  });
});

describe("nuka run: setDefaultTimeout never called leaves compat steps unbounded", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-no-default-timeout-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("a step with no own timeout, and no default configured anywhere in the project, still passes", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "features/no-default-timeout.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
  });
});

describe("nuka run: BeforeAll/AfterAll run once per run, in LIFO order for AfterAll", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-run-all-hooks-project");
    (globalThis as Record<string, unknown>).__nukadokoRunAllHooksLog = [];
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("BeforeAll runs once (not once per scenario); both AfterAll registrations are attempted, in reverse registration order, even though the second one throws", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/two-scenarios.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    // afterAll-B throws -> non-zero exit, even though both scenarios
    // themselves passed.
    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("afterAll-B failed on purpose");

    const records = nonEmptyLines(stdout.text()).map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.status).toBe("passed");
    }

    const log = (globalThis as Record<string, unknown>).__nukadokoRunAllHooksLog as string[];
    // afterAll-B (registered second) unwinds before afterAll-A (registered
    // first) — LIFO, the same convention src/run/run-scenario.ts's own
    // After-hook loop already uses; both are attempted despite afterAll-B's
    // own throw.
    expect(log).toEqual(["beforeAll", "afterAll-B", "afterAll-A"]);
  });

  it("neither BeforeAll nor AfterAll runs for a feature file with zero scenarios", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/empty.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("");
    const log = (globalThis as Record<string, unknown>).__nukadokoRunAllHooksLog as string[];
    expect(log).toEqual([]);
  });
});

describe("nuka run: BeforeAll's own timeout and failure fallout", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-run-all-hooks-timeout-project");
    (globalThis as Record<string, unknown>).__nukadokoRunAllHooksTimeoutLog = [];
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("BeforeAll's own { timeout } fires, stopping the second BeforeAll registration, skipping every scenario, while AfterAll still runs", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const startedAt = Date.now();
    const exitCode = await runCli(["run", "features/one-scenario.feature"], {
      rootDir,
      stdout,
      stderr,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(exitCode).toBe(1);
    // The failing hook's own sleep is 500ms; a run that actually waited for
    // it would take far longer than this bound.
    expect(elapsedMs).toBeLessThan(1200);
    expect(stderr.text()).toContain('Hook "BeforeAll" timed out after 20ms');

    // Zero scenario records: BeforeAll's failure means the scenario never
    // began (this task's spec: "scenario を 1 つも実行せず").
    expect(stdout.text()).toBe("");

    const log = (globalThis as Record<string, unknown>).__nukadokoRunAllHooksTimeoutLog as string[];
    expect(log).toEqual(["beforeAll-first", "afterAll"]);
  });
});
