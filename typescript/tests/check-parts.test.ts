import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { findPartCycles } from "../src/check/parts-check.js";
import type { Vocabulary } from "../src/discover/discover-steps.js";
import { z } from "zod";
import { defineStep, type RunStep } from "../src/step/define-step.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

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
  return { exitCode, report: bySeverity(stdout.text()) as { errors: PartIssue[]; warnings: PartIssue[] } };
}

describe("nuka check: parts findings", () => {
  // defineStep refuses a non-Step part when the file is imported, so the
  // finding is the import failure that names the file.
  it("reports a part that is not a Step", async () => {
    const { report, exitCode } = await checkReport(fixture("check-parts-project"));
    const issues = report.errors.filter((issue) => issue.file === "features/steps/not-a-step-part.ts");
    expect(issues.map(({ code, message }) => ({ code, message }))).toEqual([
      {
        code: "step-file-import-failed",
        message: "defineStep parts must be an array of steps, each produced by defineStep.",
      },
    ]);
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

  // defineStep freezes the step it returns, so a step file that closes a
  // parts cycle throws when it is imported, and no part-cycle is left.
  it("reports the step file that tries to close a parts cycle as an import failure", async () => {
    const { report } = await checkReport(fixture("check-parts-project"));
    expect(report.errors.filter((issue) => issue.code === "part-cycle")).toEqual([]);
    expect(
      report.errors
        .filter((issue) => issue.file === "features/steps/cycle-b.ts")
        .map(({ code, message }) => ({ code, message })),
    ).toEqual([{ code: "step-file-import-failed", message: "Cannot assign to read only property 'parts' of object '#<Object>'" }]);
  });

  // No step file reaches findPartCycles with a cycle any more; the check
  // stays, so a Step built another way still cannot loop unreported. The
  // copies here are not frozen, which is what lets the test close the loop.
  it("names both steps of a cycle in order, when a vocabulary holds one", () => {
    const definition = {
      description: "half of a cycle",
      args: z.object({}),
      returns: z.object({}),
      async run() {
        return {};
      },
    };
    const aParts: RunStep[] = [];
    const a = { ...defineStep(definition), parts: aParts } as RunStep;
    const b = { ...defineStep(definition), parts: [a] } as RunStep;
    aParts.push(b);
    const vocabulary = new Map([
      ["cycle-a", { kind: "typed", name: "cycle-a", filePath: "features/steps/cycle-a.ts", step: a }],
      ["cycle-b", { kind: "typed", name: "cycle-b", filePath: "features/steps/cycle-b.ts", step: b }],
    ]) as unknown as Vocabulary;
    const issues = findPartCycles(vocabulary);
    expect(issues.map((issue) => issue.step)).toEqual(["cycle-a"]);
    expect(issues[0]!.message).toContain("part cycle: cycle-a -> cycle-b -> cycle-a.");
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
