import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka check` names the CJS/.ts mismatch when it is the
// actual cause of a step-file-import-failed finding, instead of leaving
// Node's own "Cannot find module '<path>?namespace=<uuid>'" standing on its
// own — a message that reads like a missing file even though the file is
// right there (src/check/analyze.ts's own header). The sentence is only
// appended when both hold: the project is CommonJS (no "type": "module" in
// package.json) and the failed file is itself .ts — never a guess
// (CLAUDE.md: "a check that guesses is worse than no check").

describe("nuka check: CommonJS/.ts step-file-import-failed", () => {
  it("appends the CJS/.ts explanation when the project is CommonJS and the failed file is .ts", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-import-failure-cjs-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; message: string; file?: string }>;
    };
    const failure = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(failure).toBeDefined();
    // Node's own message is still there, verbatim, as the base of the
    // sentence appended to it.
    expect(failure?.message).toContain("Cannot find module");
    expect(failure?.message).toContain('"type": "module"');
    expect(failure?.message).toContain(".mts");
  });

  it("does not append anything when the project is not CommonJS (no package.json at all), even for a .ts import failure", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-import-failure-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout.text()) as {
      errors: Array<{ code: string; message: string; file?: string }>;
    };
    const failure = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(failure).toBeDefined();
    expect(failure?.message).not.toContain('"type": "module"');
    expect(failure?.message).not.toContain(".mts");
  });
});
