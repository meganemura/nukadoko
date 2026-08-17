import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka check`'s three `parts` findings (docs/spec.md
// "Parts": "Two things `nuka check` can be certain of, so it says them",
// plus the structural check that section's own "`call` refuses ... which
// the mistake `resultOf` already throws on" paragraph promises) —
// part-structural-violation (src/step/validate-parts.ts), part-cycle and
// part-mutates-contradiction (src/check/parts-check.ts), wired into
// src/check/analyze.ts.

interface PartIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly step?: string;
}

async function checkReport(rootDir: string) {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  return { exitCode, report: JSON.parse(stdout.text()) as { errors: PartIssue[]; warnings: PartIssue[] } };
}

describe("nuka check: parts findings", () => {
  it("reports a part that is not a Step", async () => {
    const { report, exitCode } = await checkReport(fixture("check-parts-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "part-structural-violation" && issue.step === "not-a-step-part",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("is not a Step");
    expect(issues[0]!.file).toBe("features/steps/not-a-step-part.ts");
    expect(exitCode).toBe(1);
  });

  it("reports a part discovery never registered, mentioning the dynamic-import possibility", async () => {
    const { report } = await checkReport(fixture("check-parts-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "part-structural-violation" && issue.step === "unregistered-part",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("never registered");
    expect(issues[0]!.message).toContain("await import()");
    expect(issues[0]!.file).toBe("features/steps/unregistered-part.ts");
  });

  it("reports a cycle in the parts graph, naming both steps in order", async () => {
    const { report } = await checkReport(fixture("check-parts-project"));
    const issues = report.errors.filter((issue) => issue.code === "part-cycle");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("cycle-a");
    expect(issues[0]!.message).toContain("cycle-b");
    expect(issues[0]!.message).toContain("->");
  });

  it("reports mutates: false contradicted by a mutates: true part", async () => {
    const { report } = await checkReport(fixture("check-parts-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "part-mutates-contradiction" && issue.step === "mutates-contradiction",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("mutates: false");
    expect(issues[0]!.message).toContain("mutating-part");
    expect(issues[0]!.message).toContain("mutates: true");
    expect(issues[0]!.file).toBe("features/steps/mutates-contradiction.ts");
  });

  it("says nothing about a step whose parts are genuinely correct", async () => {
    const { report } = await checkReport(fixture("check-parts-project"));
    const issues = report.errors.filter(
      (issue) =>
        (issue.code === "part-structural-violation" ||
          issue.code === "part-cycle" ||
          issue.code === "part-mutates-contradiction") &&
        issue.step === "valid-composite",
    );
    expect(issues).toHaveLength(0);
  });

  it("says nothing at all for a clean project with no parts at all", async () => {
    const { report, exitCode } = await checkReport(fixture("check-clean-project"));
    const issues = report.errors.filter(
      (issue) =>
        issue.code === "part-structural-violation" ||
        issue.code === "part-cycle" ||
        issue.code === "part-mutates-contradiction",
    );
    expect(issues).toHaveLength(0);
    expect(exitCode).toBe(0);
  });
});
