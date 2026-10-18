import { writeFile } from "node:fs/promises";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { fromOrderDo, fromOrderHold, type FromOrderIssue as CheckedIssue } from "../src/check/from-order.js";
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

describe("nuka check: from-order-violation's do line, and the findings an undefined line holds back", () => {
  const feature = [
    "Feature: a producer written before its step",
    "",
    "  Scenario: the earlier line has no step yet",
    "    Given a project id comes from an import",
    "    Then the project is archived",
    "    Then the project is closed",
    "",
    "  Scenario: the earlier line runs a step that is not the producer",
    '    Given a plain args failure on count "1"',
    "    Then the project is archived",
    "",
    "  Scenario: the line with no step comes after the consumer",
    "    Then the project is archived",
    "    Given a project id comes from somewhere later",
    "",
  ].join("\n");

  async function producerReport() {
    const rootDir = await copyFixtureToTempDir("from-project");
    try {
      await writeFile(path.join(rootDir, "features", "producer.feature"), feature);
      const { exitCode, report } = await checkReport(rootDir);
      const inFile = (issues: unknown[]) =>
        (issues as FromOrderIssue[]).filter(
          (issue) => issue.code.startsWith("from-order") && issue.file === "features/producer.feature",
        );
      return { exitCode, errors: inFile(report.errors), warnings: inFile(report.warnings) };
    } finally {
      await removeTempDir(rootDir);
    }
  }

  it("holds back the findings after a line no step matches in one warning at that line, and reports the rest", async () => {
    const { exitCode, errors, warnings } = await producerReport();
    expect(exitCode).toBe(1);
    expect(warnings).toEqual([
      {
        code: "from-order-check-suppressed",
        message:
          'Held back 2 from-order-violation findings while line 4 "a project id comes from an import" matches no step, because such a line may be meant to run the producer they need: line 5 step "archive-project" needs step "create-project" for projectId; line 6 step "close-project" needs step "create-project" for projectId',
        file: "features/producer.feature",
        line: 4,
        do: 'If line 4 "a project id comes from an import" is meant to run step "create-project", reword that line to match that step\'s pattern. Otherwise fix the undefined-step finding first, then run nuka check again: a held-back finding that still applies is reported then.',
      },
    ]);
    expect(errors.map((issue) => [issue.line, issue.do])).toEqual([
      [
        10,
        'Put a line that runs step "create-project" earlier in the scenario. Or, if a step that an earlier line runs returns projectId, list that step as another [step, "projectId"] candidate in from.projectId of step "archive-project".',
      ],
      [13, 'Put a line that runs step "create-project" earlier in the scenario.'],
    ]);
  });

  it("under run --no-check, fails the undefined line itself and prints each line of a scenario the guard stops", async () => {
    const rootDir = await copyFixtureToTempDir("from-project");
    try {
      await writeFile(path.join(rootDir, "features", "producer.feature"), feature);
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["run", "--records", "--no-check", "features/producer.feature"], { rootDir, stdout, stderr });

      expect(exitCode).toBe(1);
      const records = stdout
        .text()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { steps: { text: string; status: string; error?: { message: string } }[] });
      expect(records[0]!.steps.map((step) => [step.status, step.error?.message])).toEqual([
        [
          "undefined",
          'No step definition matches "a project id comes from an import"; run `nuka scaffold --feature features/producer.feature` to add one',
        ],
        ["skipped", undefined],
        ["skipped", undefined],
      ]);
      expect(stderr.text()).toContain(
        [
          "scenario 3/3  features/producer.feature:12  the line with no step comes after the consumer",
          "  step 1/2  failed  0.0s  the project is archived",
          '      Step "archive-project"\'s from.projectId needs step "create-project" to have already run earlier in this scenario, but "create-project" is never bound anywhere in this scenario. This line would fail args validation with certainty',
          "  step 2/2  skipped  0.0s  a project id comes from somewhere later",
          "",
        ].join("\n"),
      );
    } finally {
      await removeTempDir(rootDir);
    }
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

describe("fromOrderHold", () => {
  const lineText = gs.text({ minSize: 1, maxSize: 10, alphabet: "abc xyz" });

  it("stands at the first undefined line, counts every held-back issue, and names every undefined line, consumer line, and key", () =>
    hegel.test((tc) => {
      const texts = tc.draw(gs.arrays(lineText, { minSize: 2, maxSize: 8 }));
      const steps = texts.map((text, index) => ({ line: 100 + index, text }));
      const undefinedFlags = tc.draw(gs.arrays(gs.booleans(), { minSize: texts.length, maxSize: texts.length }));
      const consumerIndexes = tc.draw(gs.arrays(gs.integers({ minValue: 1, maxValue: texts.length - 1 }), { minSize: 1, maxSize: 5 }));
      const held: CheckedIssue[] = [];
      consumerIndexes.forEach((stepIndex, n) => {
        const undefinedBefore = undefinedFlags.slice(0, stepIndex).flatMap((flag, index) => (flag ? [index] : []));
        if (undefinedBefore.length === 0) return;
        held.push({
          stepIndex,
          stepName: `consume${stepIndex}`,
          message: "",
          key: `k${n}`,
          kind: "missing",
          candidates: ["produce"],
          undefinedBefore,
        });
      });
      const hold = fromOrderHold(held, steps);
      if (held.length === 0) {
        expect(hold).toBeUndefined();
        return;
      }
      const union = new Set(held.flatMap((issue) => issue.undefinedBefore));
      expect(hold!.stepIndex).toBe(Math.min(...union));
      expect(hold!.message.startsWith(`Held back ${held.length} from-order-violation finding`)).toBe(true);
      const undefinedPart = hold!.message.slice(0, hold!.message.indexOf(" no step, "));
      steps.forEach((step, index) => {
        expect(undefinedPart.includes(`line ${step.line} `)).toBe(union.has(index));
      });
      for (const issue of held) {
        expect(hold!.message).toContain(`line ${steps[issue.stepIndex]!.line} step "${issue.stepName}" needs step "produce" for `);
        expect(hold!.message).toMatch(new RegExp(`for [^;]*\\b${issue.key}\\b`));
      }
      expect(hold!.do).toContain('is meant to run step "produce", reword that line');
    }));
});
