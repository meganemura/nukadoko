import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka check`'s new static check — a required args key
// that no named capture, table/docstring, or
// declared `from` on a pickle line could ever fill is a statically certain
// args-validation failure (docs/spec.md "Typed steps": "statically checkable
// in both directions"). Every silent boundary gets
// its own assertion here (capture fills it, table/docstring fills it, from
// declares it, the key is optional, the line is compat, the line is
// undefined-step/ambiguous-step) alongside the one genuinely reported case,
// against tests/fixtures/unfillable-key-project/features/unfillable.feature
// (see that fixture's own step files for why each scenario is silent or
// not).

async function checkReport(rootDir: string) {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  return { exitCode, report: JSON.parse(stdout.text()) as { errors: unknown[]; warnings: unknown[] } };
}

interface UnfillableKeyIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
}

const rootDir = fixture("unfillable-key-project");
// This fixture project also carries features/run-guard.feature (tests/run-
// unfillable-key.test.ts's own target), which has one genuine violation of
// its own — every assertion below filters by *this* file too, not just line
// and code, so it stays independent of that other feature's own findings.
const thisFile = "features/unfillable.feature";

describe("nuka check: unfillable required args keys", () => {
  it("errors when a required key has no capture, table/docstring, or from at all", async () => {
    const { report } = await checkReport(rootDir);
    const issues = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "unfillable-required-key" && issue.file === thisFile && issue.line === 18,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('"serial"');
    expect(issues[0]!.step).toBe("unfillable");
    // The message names all four remedies (there is no
    // fifth way to fill a required key, so the list is a fact, not a guess).
    expect(issues[0]!.message).toContain("named capture");
    expect(issues[0]!.message).toContain("table/docstring");
    expect(issues[0]!.message).toContain("from.serial");
    expect(issues[0]!.message).toContain("optional");
  });

  it("says nothing when a pattern capture fills the required key", async () => {
    const { report } = await checkReport(rootDir);
    const issues = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "unfillable-required-key" && issue.file === thisFile && issue.line === 3,
    );
    expect(issues).toHaveLength(0);
  });

  it("says nothing when a table attachment fills the required key", async () => {
    const { report } = await checkReport(rootDir);
    const issues = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "unfillable-required-key" && issue.file === thisFile && issue.line === 6,
    );
    expect(issues).toHaveLength(0);
  });

  it("says nothing when the required key has a declared from, and does not double-report with from-order", async () => {
    const { report } = await checkReport(rootDir);
    const unfillable = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "unfillable-required-key" && issue.file === thisFile && issue.line === 11,
    );
    expect(unfillable).toHaveLength(0);
    const fromOrder = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "from-order-violation" && issue.file === thisFile && issue.line === 11,
    );
    expect(fromOrder).toHaveLength(0);
  });

  it("says nothing when the key is optional", async () => {
    const { report } = await checkReport(rootDir);
    const issues = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "unfillable-required-key" && issue.file === thisFile && issue.line === 15,
    );
    expect(issues).toHaveLength(0);
  });

  it("says nothing for a compat step's line", async () => {
    const { report } = await checkReport(rootDir);
    const issues = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "unfillable-required-key" && issue.file === thisFile && issue.line === 21,
    );
    expect(issues).toHaveLength(0);
  });

  it("says nothing for an undefined-step line", async () => {
    const { report } = await checkReport(rootDir);
    const issues = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "unfillable-required-key" && issue.file === thisFile && issue.line === 24,
    );
    expect(issues).toHaveLength(0);
    // Confirms the fixture actually reaches undefined-step, not some other
    // shape, so the assertion above isn't vacuous.
    const undefinedStep = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "undefined-step" && issue.file === thisFile && issue.line === 24,
    );
    expect(undefinedStep).toHaveLength(1);
  });

  it("says nothing for an ambiguous-step line", async () => {
    const { report } = await checkReport(rootDir);
    const issues = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "unfillable-required-key" && issue.file === thisFile && issue.line === 27,
    );
    expect(issues).toHaveLength(0);
    // Confirms the fixture actually reaches ambiguous-step, not some other
    // shape, so the assertion above isn't vacuous.
    const ambiguousStep = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "ambiguous-step" && issue.file === thisFile && issue.line === 27,
    );
    expect(ambiguousStep).toHaveLength(1);
  });

  it("reports exactly one unfillable-required-key issue in this feature file", async () => {
    const { report } = await checkReport(rootDir);
    const issues = (report.errors as UnfillableKeyIssue[]).filter(
      (issue) => issue.code === "unfillable-required-key" && issue.file === thisFile,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(18);
  });
});
