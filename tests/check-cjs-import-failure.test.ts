import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";
import { bySeverity } from "./helpers/envelope.js";

// Responsibility: `nuka check` names the CJS/.ts mismatch when it is the
// actual cause of a step-file-import-failed finding, instead of leaving
// Node's own "Cannot use import statement outside a module" standing on
// its own, a message that reads like a mistake in the file rather than in
// package.json. The sentence is only appended when both hold: package.json
// says "type": "commonjs" and the failed file is itself .ts. With no
// "type" at all, Node reparses the file as an ES module, so a failure there
// has another cause and the sentence would be a guess.

describe("nuka check: CommonJS/.ts step-file-import-failed", () => {
  it("appends the CJS/.ts explanation when package.json says \"type\": \"commonjs\" and the failed file is .ts", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["check", "--json"], {
      rootDir: fixture("check-import-failure-cjs-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(1);
    const report = bySeverity(stdout.text()) as {
      errors: Array<{ code: string; message: string; file?: string }>;
    };
    const failure = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(failure).toBeDefined();
    // Node's own message is still there, verbatim, as the base of the
    // sentence appended to it.
    expect(failure?.message).toContain("Cannot use import statement outside a module");
    expect(failure?.message).toContain('"type": "commonjs"');
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
    const report = bySeverity(stdout.text()) as {
      errors: Array<{ code: string; message: string; file?: string }>;
    };
    const failure = report.errors.find((issue) => issue.code === "step-file-import-failed");
    expect(failure).toBeDefined();
    expect(failure?.message).not.toContain('"type": "commonjs"');
    expect(failure?.message).not.toContain(".mts");
  });
});
