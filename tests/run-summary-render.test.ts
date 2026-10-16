import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { renderRunSummary, type RunSummaryInput, type SummaryScenario } from "../src/run/run-summary.js";

// Responsibility: the exact Markdown of the run summary `nuka run` writes,
// built from literal inputs: a green run, a red run, and a run whose step
// declared `mutates: false` and was measured writing. The property is that
// every scenario record of a run gets exactly one row, whatever its name,
// feature, or line, so a reviewer never reads a run with a scenario missing
// or counted twice.

const base: RunSummaryInput = {
  runId: "run-20261015-120000-abcd",
  verdict: "passed",
  startedAt: new Date("2026-10-15T12:00:00.000Z"),
  finishedAt: new Date("2026-10-15T12:01:05.000Z"),
  nukadokoVersion: "0.14.1",
  environment: "default",
  targetVersion: undefined,
  git: { commit: "0123456789abcdef0123456789abcdef01234567", clean: true },
  browsers: [],
  scenarios: [],
  declaredVsObserved: { mismatches: [], compatStepCount: 0 },
  rerunFlags: [],
};

describe("renderRunSummary", () => {
  it("renders a green run", () => {
    const markdown = renderRunSummary({
      ...base,
      browsers: [{ type: "chromium", version: "141.0.7390.37" }],
      scenarios: [
        { feature: "features/login.feature", line: 9, scenario: "a wrong password is refused", status: "passed", durationMs: 800 },
        { feature: "features/cart.feature", line: 3, scenario: "an item is added", status: "passed", durationMs: 1250 },
        { feature: "features/login.feature", line: 3, scenario: "a member signs in", status: "passed", durationMs: 2049 },
      ],
    });
    expect(markdown).toBe(
      [
        "<!-- nukadoko:run -->",
        "# nukadoko run passed: 3 scenarios, 3 passed",
        "",
        "- commit: `0123456`",
        "- environment: default",
        "- browser: chromium 141.0.7390.37",
        "- nukadoko: 0.14.1",
        "- run: run-20261015-120000-abcd",
        "- started 2026-10-15T12:00:00.000Z, finished 2026-10-15T12:01:05.000Z (1m 5s)",
        "",
        "## features/cart.feature",
        "",
        "| scenario | line | status | duration | failure |",
        "| --- | --- | --- | --- | --- |",
        "| an item is added | 3 | passed | 1.3s |  |",
        "",
        "## features/login.feature",
        "",
        "| scenario | line | status | duration | failure |",
        "| --- | --- | --- | --- | --- |",
        "| a member signs in | 3 | passed | 2.0s |  |",
        "| a wrong password is refused | 9 | passed | 0.8s |  |",
        "",
        "## Declared vs observed",
        "",
        "No step declared `mutates: false` and was measured making a write.",
        "",
      ].join("\n"),
    );
  });

  it("renders a red run with the failing step, its error, and how to rerun it", () => {
    const markdown = renderRunSummary({
      ...base,
      verdict: "failed",
      environment: "staging",
      targetVersion: "2.4.0",
      git: { commit: "fedcba9876543210fedcba9876543210fedcba98", clean: false },
      rerunFlags: ["--env", "staging"],
      scenarios: [
        { feature: "features/login.feature", line: 3, scenario: "a member signs in", status: "passed", durationMs: 1000 },
        {
          feature: "features/login.feature",
          line: 9,
          scenario: "a wrong password | is refused",
          status: "failed",
          durationMs: 400,
          failure: {
            where: 'step "the error <b>Locked</b> is shown"',
            errorLine: "expected `Locked` | got `Open`",
            recordPath: ".nukadoko/records/steps/stp-1",
            command: "npm run seed",
          },
        },
        {
          feature: "features/login.feature",
          line: 15,
          scenario: "a session expires",
          status: "failed",
          durationMs: 0,
          failure: { where: "Before hook", errorLine: "(no message)", recordPath: ".nukadoko/records/scenarios/scn-2" },
        },
      ],
    });
    expect(markdown).toBe(
      [
        "<!-- nukadoko:run -->",
        "# nukadoko run failed: 3 scenarios, 1 passed, 2 failed",
        "",
        "- commit: `fedcba9` with uncommitted changes",
        "- environment: staging (target version 2.4.0)",
        "- browser: none launched",
        "- nukadoko: 0.14.1",
        "- run: run-20261015-120000-abcd",
        "- started 2026-10-15T12:00:00.000Z, finished 2026-10-15T12:01:05.000Z (1m 5s)",
        "",
        "## features/login.feature",
        "",
        "| scenario | line | status | duration | failure |",
        "| --- | --- | --- | --- | --- |",
        "| a member signs in | 3 | passed | 1.0s |  |",
        '| a wrong password \\| is refused | 9 | failed | 0.4s | step "the error &lt;b>Locked&lt;/b> is shown": `` expected `Locked` \\| got `Open` ``<br>ran `npm run seed`<br>record `.nukadoko/records/steps/stp-1` |',
        "| a session expires | 15 | failed | 0.0s | Before hook: `(no message)`<br>record `.nukadoko/records/scenarios/scn-2` |",
        "",
        "## Declared vs observed",
        "",
        "No step declared `mutates: false` and was measured making a write.",
        "",
        "## Rerun a failed scenario",
        "",
        "```sh",
        "nuka run features/login.feature:9 --env staging",
        "nuka run features/login.feature:15 --env staging",
        "```",
        "",
      ].join("\n"),
    );
  });

  it("says when the run failed outside every scenario", () => {
    const markdown = renderRunSummary({
      ...base,
      verdict: "failed",
      git: undefined,
      scenarios: [{ feature: "features/a.feature", line: 2, scenario: "s", status: "passed", durationMs: 10 }],
    });
    expect(markdown.split("\n").slice(0, 6)).toEqual([
      "<!-- nukadoko:run -->",
      "# nukadoko run failed: 1 scenario, 1 passed",
      "",
      "No scenario record failed, but the run did: a BeforeAll or AfterAll hook, or a worker that wrote no record, failed outside every scenario. The run's stderr names it.",
      "",
      "- commit: unknown (no git state was readable when the run started)",
    ]);
  });

  it("lists a step that declared mutates: false and was measured writing", () => {
    const markdown = renderRunSummary({
      ...base,
      scenarios: [{ feature: "features/a.feature", line: 2, scenario: "a report is read", status: "passed", durationMs: 10 }],
      declaredVsObserved: {
        mismatches: [{ scenarioName: "a report is read", stepText: "the report is fetched", writes: 1 }],
        compatStepCount: 2,
      },
    });
    expect(markdown.slice(markdown.indexOf("## Declared vs observed"))).toBe(
      [
        "## Declared vs observed",
        "",
        "Steps that declared `mutates: false` and were measured making writes. This is a comparison, not a verdict: a step that reads over POST records writes by design.",
        "",
        '- "the report is fetched" (scenario "a report is read"): declared mutates: false, observed 1 write',
        "",
        "2 compat steps have no `mutates` declaration to compare.",
        "",
      ].join("\n"),
    );
  });

  it("gives every scenario record of the run exactly one row", () =>
    hegel.test((tc) => {
      const scenarios: SummaryScenario[] = tc.draw(
        gs.arrays(
          gs.composite((inner) => {
            const status = inner.draw(gs.sampledFrom(["passed", "failed"] as const));
            const scenario: SummaryScenario = {
              feature: `features/${inner.draw(gs.sampledFrom(["a", "b", "c d", "e|f"]))}.feature`,
              line: inner.draw(gs.integers({ minValue: 1, maxValue: 400 })),
              scenario: inner.draw(gs.text({ maxSize: 20, alphabet: "abc |<>`*_" })),
              status,
              durationMs: inner.draw(gs.integers({ minValue: 0, maxValue: 100_000 })),
              ...(status === "failed"
                ? { failure: { where: 'step "x"', errorLine: inner.draw(gs.text({ minSize: 1, maxSize: 20, alphabet: "ab|`<" })), recordPath: null } }
                : {}),
            };
            return scenario;
          }),
          { maxSize: 12 },
        ),
      );
      // Each row carries a unique duration, so a row can be traced back to
      // the one input it came from.
      const tagged = scenarios.map((scenario, index) => ({ ...scenario, durationMs: index * 100_000 }));
      const markdown = renderRunSummary({ ...base, scenarios: tagged });
      const rows = markdown.split("\n").filter((line) => /^\| .* \| (passed|failed) \| \d+\.\ds \|/.test(line));
      expect(rows).toHaveLength(tagged.length);
      for (const scenario of tagged) {
        const duration = `| ${(scenario.durationMs / 1000).toFixed(1)}s |`;
        expect(rows.filter((row) => row.includes(duration))).toHaveLength(1);
      }
    }));
});
