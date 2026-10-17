import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: done-callback compat glue is decidable before a run.
// A hook is over the executor's limit when Before/After/AfterStep declare
// two or more parameters, or BeforeAll/AfterAll declare one or more. A
// matched compat step is over the limit when fn.length exceeds that line's
// captures plus one for a table or docstring. A "pending" return, an
// unmatched definition, and an ambiguous line are not this finding.

interface CheckIssue {
  code: string;
  message: string;
  file?: string;
  line?: number;
  step?: string;
}

describe("nuka check: done-callback arity", () => {
  it("reports done-callback-arity for hooks and matched steps, and stays silent everywhere else", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-done-callback-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const report = JSON.parse(stdout.text()) as {
      errors: CheckIssue[];
      warnings: CheckIssue[];
    };

    // Its scenarios have no Then line, on purpose: moving the compat steps to Then would raise then-compat-step instead.
    expect(report.warnings.filter((issue) => issue.code !== "scenario-without-then")).toEqual([]);
    expect([...new Set(report.errors.map((issue) => issue.code))].sort()).toEqual([
      "ambiguous-step",
      "done-callback-arity",
    ]);
    expect(report.errors.filter((issue) => issue.code === "ambiguous-step")).toHaveLength(1);

    const arity = report.errors.filter((issue) => issue.code === "done-callback-arity");
    const hooks = arity.filter((issue) => issue.step === undefined);
    const steps = arity.filter((issue) => issue.step !== undefined);

    expect(hooks.map((issue) => issue.message)).toEqual([
      expect.stringContaining('Hook "Before"'),
      expect.stringContaining('Hook "After"'),
      expect.stringContaining('Hook "AfterStep"'),
      expect.stringContaining('Hook "BeforeAll"'),
      expect.stringContaining('Hook "AfterAll"'),
    ]);
    for (const issue of hooks) {
      expect(issue.file).toBeUndefined();
      expect(issue.message).toContain("done()");
      expect(issue.message).toContain("docs/migration.md");
    }

    expect(steps.map((issue) => ({ step: issue.step, file: issue.file, line: issue.line }))).toEqual([
      { step: "compat: a user {string} exists", file: "features/done.feature", line: 4 },
      { step: "compat: a legacy step expects a done callback", file: "features/done.feature", line: 10 },
      { step: "compat: a note:", file: "features/done.feature", line: 13 },
      { step: 'compat: /a regexp user "(.*)" exists/', file: "features/done.feature", line: 27 },
    ]);
    for (const issue of steps) {
      expect(issue.message).toContain("done()");
      expect(issue.message).toContain("docs/migration.md");
    }
    const joined = arity.map((issue) => issue.message).join("\n");
    expect(joined).not.toContain("nobody calls");
    expect(joined).not.toContain("ambiguous thing");
    expect(joined).not.toContain("is recorded");
    expect(joined).not.toContain("these rows");
    expect(joined).not.toContain("owns");
    expect(joined).not.toContain("returns pending");

    expect(exitCode).toBe(1);
  });

  it("lists done-callback-arity in nuka check --codes", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--codes", "--json"], {
      rootDir: fixture("check-done-callback-project"),
      stdout,
      stderr,
    });

    expect(stderr.text()).toBe("");
    const codes = JSON.parse(stdout.text()).codes as Array<{ code: string; description: string; severity?: string }>;
    const entry = codes.find((item) => item.code === "done-callback-arity");
    expect(entry?.description.length).toBeGreaterThan(0);
    expect(entry?.severity).toBe("error");
    expect(exitCode).toBe(0);
  });
});
