import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka check`'s fixture-bag structural check
// (src/step/validate-fixtures.ts's `validateStepFixtures`, wired into
// src/check/analyze.ts — p4a-fixture-bag task spec, scope item 3: "nuka
// check と nuka run が同じ検査を共有する形にすること") — the same shape
// tests/check-structural-from.test.ts already proves for `from`'s own
// structural check, applied to fixture names instead.

interface FixtureStructuralIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly step?: string;
}

async function checkReport(rootDir: string) {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  return {
    exitCode,
    report: JSON.parse(stdout.text()) as { errors: FixtureStructuralIssue[]; warnings: unknown[] },
  };
}

describe("nuka check: fixture bag's structural check", () => {
  it("reports an unknown destructured fixture name, naming it", async () => {
    const { report, exitCode } = await checkReport(fixture("fixture-bag-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "fixture-structural-violation" && issue.step === "unknown-fixture-step",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('unknown fixture "bogus"');
    expect(issues[0]!.file).toBe("features/steps/unknown-fixture-step.ts");
    expect(exitCode).toBe(1);
  });

  it("reports a default value on a destructured fixture, by its own dedicated message", async () => {
    const { report } = await checkReport(fixture("fixture-bag-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "fixture-structural-violation" && issue.step === "default-value-step",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("default value");
  });

  it("reports a rest property in the fixture destructuring", async () => {
    const { report } = await checkReport(fixture("fixture-bag-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "fixture-structural-violation" && issue.step === "rest-step",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("rest property");
  });

  it("reports a run() whose first argument isn't destructured at all", async () => {
    const { report } = await checkReport(fixture("fixture-bag-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "fixture-structural-violation" && issue.step === "not-destructured-step",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("destructure");
  });

  it("says nothing about a step whose fixture destructuring is genuinely clean", async () => {
    const { report } = await checkReport(fixture("fixture-bag-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "fixture-structural-violation" && issue.step === "clean-step",
    );
    expect(issues).toHaveLength(0);
  });

  it("says nothing at all for a clean project with no fixture issues", async () => {
    const { report, exitCode } = await checkReport(fixture("check-clean-project"));
    const issues = report.errors.filter((issue) => issue.code === "fixture-structural-violation");
    expect(issues).toHaveLength(0);
    expect(exitCode).toBe(0);
  });
});
