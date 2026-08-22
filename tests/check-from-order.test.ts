import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka check`'s scenario-order check (docs/spec.md
// "Chaining steps"' "Declaring `from` buys a
// check that costs nothing to be sure about" paragraph) — every silent case
// (capture wins, table/docstring wins, optional key, upstream bound earlier,
// Background) and every reported case (upstream missing entirely, upstream
// bound too late), against tests/fixtures/from-project (already the m6a-
// from-core fixture; this task extends it rather than adding a second
// project, so the two check-time `alias-key-mismatch` steps documented on
// features/steps/archive-project.ts are pre-existing and unrelated to this
// file's own assertions — every assertion below filters by
// `from-order-violation` specifically instead of asserting on the whole
// report).

async function checkReport(rootDir: string) {
  const stdout = createCaptureSink();
  const exitCode = await runCli(["check", "--json"], { rootDir, stdout, stderr: createCaptureSink() });
  return { exitCode, report: JSON.parse(stdout.text()) as { errors: unknown[]; warnings: unknown[] } };
}

interface FromOrderIssue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
}

describe("nuka check: from's scenario-order check", () => {
  it("errors when the upstream is never bound anywhere in the scenario", async () => {
    const { report } = await checkReport(fixture("from-project"));
    const issues = (report.errors as FromOrderIssue[]).filter(
      (issue) => issue.code === "from-order-violation" && issue.line === 12,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("archive-project");
    expect(issues[0]!.message).toContain("create-project");
    expect(issues[0]!.message).toContain("never bound anywhere in this scenario");
    expect(issues[0]!.file).toBe("features/chain.feature");
  });

  it("errors when the upstream is bound, but only after this line — a different message, same code", async () => {
    const { report } = await checkReport(fixture("from-project"));
    const issues = (report.errors as FromOrderIssue[]).filter(
      (issue) => issue.code === "from-order-violation" && issue.line === 24,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("only at or after this line, never before it");
    // Distinct wording from the "missing" case above (same code).
    expect(issues[0]!.message).not.toContain("never bound anywhere in this scenario");
  });

  it("says nothing when the upstream is bound earlier in the same scenario", async () => {
    const { report } = await checkReport(fixture("from-project"));
    const issues = (report.errors as FromOrderIssue[]).filter(
      (issue) => issue.code === "from-order-violation" && issue.line === 5,
    );
    expect(issues).toHaveLength(0);
  });

  it("says nothing when a pattern capture fills the key, even with no upstream at all", async () => {
    const { report } = await checkReport(fixture("from-project"));
    const issues = (report.errors as FromOrderIssue[]).filter(
      (issue) => issue.code === "from-order-violation" && issue.line === 28,
    );
    expect(issues).toHaveLength(0);
  });

  it("says nothing when the from key is optional, even with no upstream at all", async () => {
    const { report } = await checkReport(fixture("from-project"));
    const issues = (report.errors as FromOrderIssue[]).filter(
      (issue) => issue.code === "from-order-violation" && issue.line === 31,
    );
    expect(issues).toHaveLength(0);
  });

  it("says nothing when the upstream is bound in this scenario's own Background", async () => {
    const { report } = await checkReport(fixture("from-project"));
    const issues = (report.errors as FromOrderIssue[]).filter(
      (issue) => issue.code === "from-order-violation" && issue.file === "features/chain-background.feature",
    );
    expect(issues).toHaveLength(0);
  });

  it("reports exactly two from-order-violation issues in this fixture, one per genuinely broken scenario", async () => {
    const { report } = await checkReport(fixture("from-project"));
    const issues = (report.errors as FromOrderIssue[]).filter((issue) => issue.code === "from-order-violation");
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.line).sort()).toEqual([12, 24]);
  });
});
