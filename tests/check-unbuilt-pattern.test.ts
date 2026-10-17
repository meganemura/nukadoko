import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: a pattern that cannot be built is reported once, and the
// lines it would have matched are not also reported as undefined steps that
// tell the author to scaffold a step that exists.

interface Issue {
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly step?: string;
}

describe("nuka check: a pattern that cannot be built", () => {
  it("holds back undefined-step on each line the pattern would match", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-unbuilt-pattern-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = JSON.parse(stdout.text()) as { errors: readonly Issue[]; warnings: readonly Issue[] };

    expect(exitCode).toBe(1);
    expect(report.errors.map((issue) => issue.code)).toEqual(["unknown-parameter-type"]);
    expect(report.warnings).toEqual(
      [4, 7, 10].map((line) => ({
        code: "undefined-step-check-suppressed",
        message: `"${(line - 1) / 3} items are added" would match step "add-items" once its pattern builds. Fix the pattern error reported for that step`,
        file: "features/items.feature",
        line,
        do: "Fix the step-file-import-failed or playwright-missing finding, or the pattern error, that held it back, then run nuka check again.",
      })),
    );
  });
});
