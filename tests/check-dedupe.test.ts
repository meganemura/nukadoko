import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: a Background line and an outline's template line reach
// `nuka check` once per pickle, and each finding about such a line is still
// reported once. tests/fixtures/check-dedupe-project's Background is shared
// by three pickles (one Scenario, two Examples rows), and its outline lines
// repeat across the two rows. Its last scenario repeats a step's text on
// lines of their own: each line gets its own finding, an undefined text
// included, since each line is one the author has to change.

interface Issue {
  readonly code: string;
  readonly line?: number;
  readonly step?: string;
}

describe("nuka check: a finding on a line repeated across pickles", () => {
  it("is reported once per line, an undefined text on each of its lines", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-dedupe-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = bySeverity(stdout.text()) as {
      errors: readonly Issue[];
      warnings: readonly Issue[];
    };
    const shape = (issues: readonly Issue[]) =>
      issues.map(({ code, line, step }) => ({ code, line, step }));

    expect(exitCode).toBe(1);
    expect(shape(report.errors)).toEqual([
      { code: "ambiguous-step", line: 4, step: undefined },
      { code: "unfillable-required-key", line: 5, step: "title-set" },
      { code: "then-without-claims", line: 11, step: "item-saved" },
      { code: "table-docstring-key-mismatch", line: 12, step: "note-added" },
      { code: "then-without-claims", line: 23, step: "item-saved" },
      { code: "undefined-step", line: 24, step: undefined },
      { code: "undefined-step", line: 25, step: undefined },
    ]);
    // Each scenario whose only Then binds a step that runs judges no claim,
    // and the outline's two rows share one line, so one warning each.
    expect(shape(report.warnings)).toEqual([
      { code: "scenario-without-then", line: 11, step: undefined },
      { code: "scenario-without-then", line: 23, step: undefined },
    ]);
  });
});
