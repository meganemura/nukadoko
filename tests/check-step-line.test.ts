import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: a feature-derived `nuka check` finding names the exact
// line its own step is on, not the enclosing Scenario's line — against
// tests/fixtures/check-step-line-project's own two-step scenario, where the
// Scenario line, the Given's line, and the Then's line are three different
// line numbers. A regression back to reporting the pickle's Scenario line
// for either finding below turns this red: line 3 is `Scenario: ...`,
// never a step either check could be about.

interface Issue {
  readonly code: string;
  readonly file?: string;
  readonly line?: number;
}

async function checkReport(): Promise<{ exitCode: number; errors: readonly Issue[] }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", "features/probe.feature", "--json"], {
    rootDir: fixture("check-step-line-project"),
    stdout,
    stderr: createCaptureSink(),
  });
  const report = JSON.parse(stdout.text()) as { errors: readonly Issue[] };
  return { exitCode, errors: report.errors };
}

describe("nuka check: a feature-derived finding's line is its own step's line", () => {
  it("undefined-step names the Then step's line, two lines below the Scenario line", async () => {
    const { exitCode, errors } = await checkReport();
    expect(exitCode).toBe(1);
    const issue = errors.find((e) => e.code === "undefined-step");
    expect(issue).toBeDefined();
    expect(issue!.line).toBe(5);
  });

  it("unfillable-required-key names the Given step's line, one line below the Scenario line", async () => {
    const { errors } = await checkReport();
    const issue = errors.find((e) => e.code === "unfillable-required-key");
    expect(issue).toBeDefined();
    expect(issue!.line).toBe(4);
  });
});
