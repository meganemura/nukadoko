import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: the undefined-step escape hint sees a parameter type that
// compat code registered, the same registry matching uses. The fixture's
// pattern has a bare "(north)" before a compat-registered {c:color}.

describe("nuka check: escape hint with a compat parameter type", () => {
  it("names the step whose pattern would match once its parens are escaped", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-escape-hint-compat-project"),
      stdout,
      stderr: createCaptureSink(),
    });
    const report = bySeverity(stdout.text()) as {
      errors: readonly { code: string; message: string; line?: number }[];
    };

    expect(exitCode).toBe(1);
    expect(report.errors.filter((issue) => issue.code === "undefined-step")).toEqual([
      {
        code: "undefined-step",
        message:
          'No step definition matches "the wall (north) is painted red"; it would match step "paint" pattern "the wall (north) is painted {c:color}" if its bare ( ) / were escaped (cucumber-expressions reads bare ( ) as optional text and / as alternation); patterned steps no scanned feature line binds: paint ("the wall (north) is painted {c:color}", features/steps/paint.ts)',
        file: "features/wall.feature",
        line: 4,
        fix: 'Escape the bare ( ) and / in the pattern of step "paint" as \\( \\) and \\/.',
      },
    ]);
  });
});
