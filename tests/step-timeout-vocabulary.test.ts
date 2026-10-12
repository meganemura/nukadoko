import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: a step's own `defineStep({ timeout })` shows in `nuka
// steps` and `nuka describe`, so a reader learns the deadline before the
// step runs. A step without one shows nothing: `stepTimeout` applies.

describe("nuka steps / nuka describe: a step's declared timeout", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("step-timeout-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("steps --json carries timeout only for the step that declares one", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], { rootDir, stdout, stderr: createCaptureSink() });

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout.text()) as { steps: Array<{ name: string; timeout?: number }> };
    expect(report.steps.find((s) => s.name === "wait-for-export")?.timeout).toBe(30000);
    expect(report.steps.find((s) => s.name === "read-status")).not.toHaveProperty("timeout");
  });

  it("steps names the declared timeout on the step's first line", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps"], { rootDir, stdout, stderr: createCaptureSink() });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe(
      [
        "read-status  typed  read-only",
        "  the status is read",
        "  Read the status",
        "",
        "wait-for-export  typed  read-only  timeout 30000ms",
        "  the export finishes",
        "  Wait for the export job to finish",
        "",
      ].join("\n"),
    );
  });

  it("describe carries timeout only for the step that declares one", async () => {
    const declaring = createCaptureSink();
    expect(await runCli(["describe", "wait-for-export"], { rootDir, stdout: declaring, stderr: createCaptureSink() })).toBe(0);
    expect(JSON.parse(declaring.text()).timeout).toBe(30000);

    const plain = createCaptureSink();
    expect(await runCli(["describe", "read-status"], { rootDir, stdout: plain, stderr: createCaptureSink() })).toBe(0);
    expect(JSON.parse(plain.text())).not.toHaveProperty("timeout");
  });
});
