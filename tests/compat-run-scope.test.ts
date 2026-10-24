import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { discoverSteps } from "../src/discover/discover-steps.js";
import {
  copyFixtureToTempDir,
  createCaptureSink,
  removeTempDir,
  stripRunProgressLines,
} from "./helpers/fixtures.js";

// Responsibility: end-to-end coverage —
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

// The fixtures' long-running steps and hooks wait on a promise only the test
// settles, instead of a sleep. A run that waited for one would never
// return, so "did not wait" is shown by the run returning at all, with the
// step still held, rather than by a duration a loaded machine can stretch.
const g = globalThis as Record<string, unknown>;

function heldSteps(): Array<() => void> {
  return (g.__nukadokoHeldSteps as Array<() => void> | undefined) ?? [];
}

function releaseHeldSteps(): void {
  for (const release of heldSteps()) release();
  g.__nukadokoHeldSteps = [];
}

afterEach(() => {
  releaseHeldSteps();
});

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
    const exitCode = await runCli(["run", "--records", "--no-check", "features/default-timeout-step.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);

    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(heldSteps()).toHaveLength(1);
    expect(record.status).toBe("failed");
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[0].error.message).toContain("timed out after 20ms");
  });

  it("a step's own (larger) timeout overrides the default: the scenario passes", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/step-own-timeout-overrides-default.feature"], {
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
    const exitCode = await runCli(["run", "--records", "--no-check", "features/default-timeout-hook.feature"], {
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
    const exitCode = await runCli(["run", "--records", "--no-check", "features/hook-own-timeout-overrides-default.feature"], {
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
    const exitCode = await runCli(["run", "--records", "--no-check", "features/no-default-timeout.feature"], {
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
    const exitCode = await runCli(["run", "--records", "--no-check", "features/two-scenarios.feature"], {
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
    const exitCode = await runCli(["run", "--records", "--no-check", "features/empty.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stripRunProgressLines(stderr.text())).toBe("");
    const log = (globalThis as Record<string, unknown>).__nukadokoRunAllHooksLog as string[];
    expect(log).toEqual([]);
  });
});

describe("nuka run: a negative compat timeout means no timeout", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("compat-negative-timeout-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("setDefaultTimeout(-1) does not fail a step with no own timeout", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/negative-default-timeout.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps[0].status).toBe("passed");
  });

  it("a step's own { timeout: -1 } does not fail the step", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/negative-step-timeout.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    expect(record.steps[0].status).toBe("passed");
  });

  it("setDefaultTimeout(-1) does not fail a Before hook with no own timeout", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/negative-default-hook.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(0);
    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(record.status).toBe("passed");
    const beforeHooks = record.hooks.filter((h: { type: string }) => h.type === "before");
    expect(beforeHooks.some((h: { status: string }) => h.status === "failed")).toBe(false);
  });

  it("a positive step timeout still applies when the default is negative", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["run", "--records", "--no-check", "features/positive-step-timeout.feature"], {
      rootDir,
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);

    const record = JSON.parse(nonEmptyLines(stdout.text())[0]!);
    expect(heldSteps()).toHaveLength(1);
    expect(record.status).toBe("failed");
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[0].error.message).toContain("timed out after 30ms");
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
    const exitCode = await runCli(["run", "--records", "--no-check", "features/one-scenario.feature"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(heldSteps()).toHaveLength(1);
    expect(stderr.text()).toContain('Hook "BeforeAll" timed out after 20ms');

    // Zero scenario records: BeforeAll's failure means the scenario never
    // began (not a single scenario runs).
    expect(stdout.text()).toBe("");

    const log = (globalThis as Record<string, unknown>).__nukadokoRunAllHooksTimeoutLog as string[];
    expect(log).toEqual(["beforeAll-first", "afterAll"]);
  });

  for (const concurrency of ["1", "2"]) {
    it(`gives each scenario BeforeAll kept from running a not-run cell, and names the environment, at --concurrency ${concurrency}`, async () => {
      await copyFile(join(rootDir, "features", "one-scenario.feature"), join(rootDir, "features", "two-scenario.feature"));
      const stdout = createCaptureSink();
      const exitCode = await runCli(["run", "--json", "--no-check", "--concurrency", concurrency, "features"], {
        rootDir,
        stdout,
        stderr: createCaptureSink(),
      });
      expect(exitCode).toBe(1);
      const document = JSON.parse(stdout.text()) as {
        counts: unknown;
        table: { rows: unknown[] };
        findings: { severity: string; code: string; message: string; do?: string }[];
      };
      const row = (feature: string) => ({
        feature,
        line: 3,
        name: "never executes because BeforeAll fails first",
        change: null,
        conditions: [],
        cells: [{ world: "head", environment: "default", role: "required", conditions: {}, outcome: "not-run", runs: 0, reason: "a BeforeAll hook failed" }],
        verdict: "failed",
        reason: "did not run in default: a BeforeAll hook failed",
      });
      expect(document.counts).toEqual({ scenarios: 0, passed: 0, failed: 0, controls: 0, not_run: 2 });
      expect(document.table.rows).toEqual([row("features/one-scenario.feature"), row("features/two-scenario.feature")]);
      const hookFailed = {
        severity: "failed",
        code: "hook-failed",
        message: 'BeforeAll failed in environment "default": Hook "BeforeAll" timed out after 20ms (its own registered timeout)',
        do: "nuka run features",
      };
      // At 2, each worker runs its own BeforeAll, and the parent reports
      // the files no worker wrote a record for.
      expect(document.findings.filter((finding) => finding.code === "hook-failed")).toEqual(concurrency === "1" ? [hookFailed] : [hookFailed, hookFailed]);
    });

    it(`counts the not-run cells in the stderr summary line, as run.json does, at --concurrency ${concurrency}`, async () => {
      await copyFile(join(rootDir, "features", "one-scenario.feature"), join(rootDir, "features", "two-scenario.feature"));
      const stderr = createCaptureSink();
      expect(await runCli(["run", "--no-check", "--concurrency", concurrency, "features"], { rootDir, stdout: createCaptureSink(), stderr })).toBe(1);
      expect(stderr.text().split("\n").filter((line) => /^\d+ scenarios?: /.test(line)).map((line) => line.replace(/  \(.*\)$/, ""))).toEqual(["0 scenarios: 0 passed, 0 failed, 2 not run"]);
    });
  }
});
