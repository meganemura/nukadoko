import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { fromOrderDo, type FromOrderIssue as CheckedIssue } from "../src/check/from-order.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

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
  readonly do?: string;
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

  it("errors on a step whose from names itself at each line no earlier line binds it", async () => {
    const FROM_ORDER_DO = 'Put a line that runs step "next-page-read" earlier in the scenario.';
    const { exitCode, report } = await checkReport(fixture("from-self-project"));
    expect(exitCode).toBe(1);
    expect(report.warnings).toEqual([]);
    const message =
      'Step "next-page-read"\'s from.cursor needs step "next-page-read" to have already run earlier in this scenario, but "next-page-read" is bound in this scenario, but only at or after this line, never before it. This line would fail args validation with certainty';
    expect(report.errors).toEqual([
      { code: "from-order-violation", message, file: "features/pages.feature", line: 4, step: "next-page-read", do: FROM_ORDER_DO },
      { code: "from-order-violation", message, file: "features/pages.feature", line: 7, step: "next-page-read", do: FROM_ORDER_DO },
    ]);
  });
});

describe("nuka check: from-order-violation's do line", () => {
  const feature = [
    "Feature: a producer written before its step",
    "",
    "  Scenario: the earlier line has no step yet",
    "    Given a project id comes from an import",
    "    Then the project is archived",
    "",
    "  Scenario: the earlier line runs a step that is not the producer",
    '    Given a plain args failure on count "1"',
    "    Then the project is archived",
    "",
  ].join("\n");

  async function doLines(): Promise<Record<number, string | undefined>> {
    const rootDir = await copyFixtureToTempDir("from-project");
    try {
      await writeFile(path.join(rootDir, "features", "producer.feature"), feature);
      const { report } = await checkReport(rootDir);
      const issues = (report.errors as FromOrderIssue[]).filter(
        (issue) => issue.code === "from-order-violation" && issue.file === "features/producer.feature",
      );
      return Object.fromEntries(issues.map((issue) => [issue.line, issue.do]));
    } finally {
      await removeTempDir(rootDir);
    }
  }

  it("names an earlier line no step matches as the producer reworded, or as a new candidate", async () => {
    expect(await doLines()).toEqual({
      5: 'Put a line that runs step "create-project" earlier in the scenario. If line 4 "a project id comes from an import", which no step matches yet, is meant to run step "create-project", reword that line to match that step\'s pattern. If it should run a new step that produces projectId, give that step projectId in returns, and list it as another [step, "projectId"] candidate in from.projectId of step "archive-project".',
      9: 'Put a line that runs step "create-project" earlier in the scenario. Or, if a step that an earlier line runs returns projectId, list that step as another [step, "projectId"] candidate in from.projectId of step "archive-project".',
    });
  });

  it("never offers removing the from entry", async () => {
    const { report } = await checkReport(fixture("from-project"));
    const dos = (report.errors as FromOrderIssue[])
      .filter((issue) => issue.code === "from-order-violation")
      .map((issue) => issue.do);
    expect(dos).toEqual([
      'Put a line that runs step "create-project" earlier in the scenario.',
      'Put a line that runs step "create-project" earlier in the scenario.',
    ]);
  });
});

describe("fromOrderDo", () => {
  const lineText = gs.text({ minSize: 1, maxSize: 10, alphabet: "abc xyz" });

  it("names exactly the earlier lines no step matches, each by its line number", () =>
    hegel.test((tc) => {
      const texts = tc.draw(gs.arrays(lineText, { minSize: 1, maxSize: 6 }));
      const steps = [...texts.map((text, index) => ({ line: 100 + index, text })), { line: 200, text: "consumer" }];
      const flags = tc.draw(gs.arrays(gs.booleans(), { minSize: texts.length, maxSize: texts.length }));
      const undefinedBefore = flags.flatMap((flag, index) => (flag ? [index] : []));
      const issue: CheckedIssue = {
        stepIndex: texts.length,
        stepName: "consume",
        message: "",
        key: "id",
        kind: "missing",
        candidates: ["produce"],
        undefinedBefore,
      };
      const text = fromOrderDo(issue, steps);
      expect(text.startsWith('Put a line that runs step "produce" earlier in the scenario.')).toBe(true);
      steps.slice(0, texts.length).forEach((step, index) => {
        expect(text.includes(`line ${step.line} `)).toBe(undefinedBefore.includes(index));
      });
      expect(text.includes("which no step matches yet")).toBe(undefinedBefore.length > 0);
      expect(text.includes('is meant to run step "produce", reword that line')).toBe(undefinedBefore.length > 0);
      expect(text).toContain('another [step, "id"] candidate in from.id of step "consume"');
    }));
});
