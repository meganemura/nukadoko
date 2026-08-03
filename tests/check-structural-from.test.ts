import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka check`'s structural `from` check
// (src/step/validate-from.ts's `validateStepFrom`, wired into
// src/check/analyze.ts by m6f-check-structural-from) — docs/spec.md
// "Chaining steps" promises "`nuka check` reports it" for an unregistered
// upstream/missing returns key/missing args key the same way `run`/`do`
// already refuse to execute over; this file is that promise's own test,
// which tests/check-from-order.test.ts's scenario-order check (a different
// finding, a different code: `from-order-violation`) does not cover.

interface FromStructuralIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly step?: string;
}

async function checkReport(rootDir: string) {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  return { exitCode, report: JSON.parse(stdout.text()) as { errors: FromStructuralIssue[]; warnings: unknown[] } };
}

describe("nuka check: from's structural check", () => {
  it("reports an unregistered upstream, mentioning the dynamic-import possibility", async () => {
    const { report, exitCode } = await checkReport(fixture("check-from-structural-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "from-structural-violation" && issue.step === "unregistered-from-step",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("never registered");
    expect(issues[0]!.message).toContain("await import()");
    expect(issues[0]!.file).toBe("features/steps/unregistered-from-step.ts");
    expect(exitCode).toBe(1);
  });

  it("reports a from key naming a returns key the upstream doesn't have", async () => {
    const { report } = await checkReport(fixture("check-from-structural-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "from-structural-violation" && issue.step === "bad-returns-key-step",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("missingKey");
    expect(issues[0]!.message).toContain("returns keys");
    expect(issues[0]!.file).toBe("features/steps/bad-returns-key-step.ts");
  });

  it("says nothing about a step whose from chain is genuinely correct", async () => {
    const { report } = await checkReport(fixture("check-from-structural-project"));
    const issues = report.errors.filter(
      (issue) => issue.code === "from-structural-violation" && issue.step === "archive-project",
    );
    expect(issues).toHaveLength(0);
  });

  it("reports the same broken step once, not once per feature it appears in", async () => {
    const { report } = await checkReport(fixture("check-from-structural-project"));
    const issues = report.errors.filter((issue) => issue.code === "from-structural-violation");
    // Exactly two structural findings in this fixture (one per broken step)
    // even though unregistered-from-step is bound in both one.feature and
    // two.feature — a structural finding is per-step, not per-occurrence.
    expect(issues).toHaveLength(2);
  });

  it("says nothing at all for a clean project with no from at all", async () => {
    const { report, exitCode } = await checkReport(fixture("check-clean-project"));
    const issues = report.errors.filter((issue) => issue.code === "from-structural-violation");
    expect(issues).toHaveLength(0);
    expect(exitCode).toBe(0);
  });
});
