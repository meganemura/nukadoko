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

async function checkReport(
  feature = "features/probe.feature",
): Promise<{ exitCode: number; errors: readonly Issue[] }> {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", feature, "--json"], {
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

// A step's own line has to survive every construct that nests one. A
// Background's steps, a Rule's Scenario's steps, and a Scenario Outline's
// template steps all reach the check through a different branch of the walk
// that builds the id-to-line map, and dropping any one of them leaves the
// pickle's own line, which is the enclosing Scenario every time. The outline
// matters twice over: its useful line is the template's, never the Examples
// row's, and the row here sits four lines further down so the two cannot be
// confused for each other.
describe("nuka check: a step's line inside Background, Rule, and Scenario Outline", () => {
  it("names each nested step's own line, never the construct that encloses it", async () => {
    const { exitCode, errors } = await checkReport("features/shapes.feature");
    expect(exitCode).toBe(1);
    const lines = errors
      .filter((e) => e.code === "undefined-step")
      .map((e) => e.line)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    // 5 is the Background's second step, 10 the step inside the Rule's
    // Scenario, 14 the outline's own Then. The enclosing lines are 3, 8,
    // and 12, and the Examples row is 18.
    expect(lines).toEqual([5, 10, 14]);
  });
});
