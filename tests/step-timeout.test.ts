import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { DEFAULT_STEP_TIMEOUT_MS } from "../src/config/schema.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a typed step that never returns is failed, not left to
// take the run with it. A project's CI hit the job limit six times in a
// row, about two and a half hours of runner time, because one step waited
// on a Playwright mouse call that carries no timeout of its own: 106 of 107
// scenarios finished and the run never reached its summary.
//
// Compat steps stay unbounded on purpose (src/compat/registry.ts: adopting
// cucumber-js's 5s default would fail an existing suite's slow step purely
// from switching), so this covers the typed side only.

const NEVER_RETURNS = [
  'import { z } from "zod";',
  'import { defineStep } from "../../nukadoko-shim.js";',
  "",
  "export default defineStep({",
  '  pattern: "the run never ends",',
  '  description: "Waits on a promise that never settles",',
  "  args: z.object({}),",
  "  returns: z.object({}),",
  "  mutates: false,",
  "  TIMEOUT_LINE",
  "  async run() {",
  "    await new Promise(() => {});",
  "    return {};",
  "  },",
  "});",
  "",
];

describe("a typed step that never returns", () => {
  let rootDir: string;

  async function writeHangingStep(timeoutLine: string): Promise<void> {
    await mkdir(path.join(rootDir, "features", "steps"), { recursive: true });
    await writeFile(
      path.join(rootDir, "features", "steps", "never-ends.ts"),
      NEVER_RETURNS.join("\n").replace("  TIMEOUT_LINE\n", timeoutLine === "" ? "" : `  ${timeoutLine}\n`),
    );
  }

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("accept-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("fails that step, names the config knob, and lets the run reach its summary", async () => {
    await writeHangingStep("timeout: 300,");
    await writeFile(
      path.join(rootDir, "features", "hang.feature"),
      "Feature: Hang\n\n  Scenario: a step that never returns\n    Given the run never ends\n",
    );

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["run", "features/hang.feature"], { rootDir, stdout, stderr });

    expect(exitCode).toBe(1);
    // The run finished rather than hanging: a summary line exists at all.
    expect(stderr.text()).toMatch(/^1 scenario: 0 passed, 1 failed/m);

    const [record] = stdout
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    expect(record.status).toBe("failed");
    expect(record.steps[0].status).toBe("failed");
    expect(record.steps[0].error.message).toContain("timed out after 300ms");
    expect(record.steps[0].error.message).toContain("the step's own timeout");
  });

  it("records the failure as a timeout, not as the step's own throw", async () => {
    await writeHangingStep("timeout: 300,");
    await writeFile(
      path.join(rootDir, "features", "hang.feature"),
      "Feature: Hang\n\n  Scenario: a step that never returns\n    Given the run never ends\n",
    );

    const stdout = createCaptureSink();
    expect(await runCli(["run", "features/hang.feature"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(1);
    const [record] = stdout.text().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));

    const { readFileSync } = await import("node:fs");
    const stepRecord = JSON.parse(
      readFileSync(path.join(rootDir, ".nukadoko", "records", "steps", record.steps[0].step_record_id, "record.json"), "utf8"),
    );
    expect(stepRecord.status).toBe("failed");
    expect(stepRecord.error.kind).toBe("timeout");
  });

  it("names stepTimeout when the step declared no timeout of its own", async () => {
    await writeHangingStep("");
    await writeFile(
      path.join(rootDir, "features", "hang.feature"),
      "Feature: Hang\n\n  Scenario: a step that never returns\n    Given the run never ends\n",
    );
    await writeFile(
      path.join(rootDir, "nukadoko.config.ts"),
      'import { defineConfig } from "./nukadoko-shim.js";\n\nexport default defineConfig({ stepTimeout: 300 });\n',
    );

    const stdout = createCaptureSink();
    expect(await runCli(["run", "features/hang.feature"], { rootDir, stdout, stderr: createCaptureSink() })).toBe(1);
    const [record] = stdout.text().split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    expect(record.steps[0].error.message).toContain("stepTimeout in nukadoko.config.ts");
  });

  it("nuka do fails the same step the same way", async () => {
    await writeHangingStep("timeout: 300,");
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["do", "never-ends", "--args", "{}"], { rootDir, stdout, stderr });
    expect(exitCode).toBe(1);
    const record = JSON.parse(stdout.text().trim());
    expect(record.status).toBe("failed");
    expect(record.error.kind).toBe("timeout");
    expect(record.error.message).toContain("timed out after 300ms");
  });

  it("leaves a step well inside the limit alone", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    expect(
      await runCli(["run", "features/greeting.feature"], { rootDir, stdout, stderr }),
      stderr.text(),
    ).toBe(0);
    expect(stdout.text()).toContain('"status":"passed"');
  });

  it("defaults to the horizon the live report already used", () => {
    // 120 heartbeat ticks of 10s (src/run/run-scenario.ts) is where this
    // tool already decided a step has stopped being worth watching. One
    // run, one horizon.
    expect(DEFAULT_STEP_TIMEOUT_MS).toBe(120 * 10_000);
  });
});
