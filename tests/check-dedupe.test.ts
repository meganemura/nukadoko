import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: a Background line and an outline's template line reach
// `nuka check` once per pickle, and each finding about such a line is still
// reported once. tests/fixtures/check-dedupe-project's Background is shared
// by three pickles (one Scenario, two Examples rows), and its outline lines
// repeat across the two rows. Its last scenario repeats a step's text on
// lines of their own: each line gets its own finding, except an undefined
// text, which is reported once per feature, at its first line.

interface Issue {
  readonly code: string;
  readonly line?: number;
  readonly step?: string;
}

describe("nuka check: a finding on a line repeated across pickles", () => {
  it("is reported once per line, and an undefined text once per feature", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-dedupe-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text()) as {
      errors: readonly Issue[];
      warnings: readonly Issue[];
    };
    const shape = (issues: readonly Issue[]) =>
      issues.map(({ code, line, step }) => ({ code, line, step }));

    expect(exitCode).toBe(1);
    expect(shape(report.errors)).toEqual([
      { code: "ambiguous-step", line: 4, step: undefined },
      { code: "unfillable-required-key", line: 5, step: "title-set" },
      { code: "table-docstring-key-mismatch", line: 12, step: "note-added" },
      { code: "undefined-step", line: 24, step: undefined },
    ]);
    expect(shape(report.warnings)).toEqual([
      { code: "then-mutates", line: 11, step: "item-saved" },
      { code: "then-mutates", line: 23, step: "item-saved" },
    ]);
  });
});
