import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: `nuka check <feature>:line` used to report "feature file
// not found" even though the file exists — `:line` just isn't a check
// argument `readFileSync` can resolve. Pins the corrected wording for that
// case, and pins the original "feature file not found" wording, unchanged,
// for a file that genuinely does not exist — the two must read as two
// different problems, or a check that always prints the same string either
// way (or one that always prints "not supported" whether or not the file
// exists) would still pass a test that only exercises one of them. No
// temp copy needed: the refusal happens in setup, before anything under
// this fixture's own `.nukadoko/` would be touched.

async function check(featureArg: string): Promise<{ exitCode: number; stderr: string }> {
  const stderr = createCaptureSink();
  const exitCode = await runCli(["check", featureArg], {
    rootDir: fixture("check-step-line-project"),
    stdout: createCaptureSink(),
    stderr,
  });
  return { exitCode, stderr: stderr.text() };
}

describe("nuka check: distinguishes an unsupported :line from a genuinely missing file", () => {
  it("names :line as unsupported, and names the real file, when the base file exists", async () => {
    const { exitCode, stderr } = await check("features/probe.feature:3");
    expect(exitCode).toBe(1);
    expect(stderr).toContain(":line is not supported");
    expect(stderr).toContain("features/probe.feature");
    expect(stderr).toContain("nuka check features/probe.feature");
    // The old wording must be gone for this case: a reader must not be
    // sent looking for a file that is right there.
    expect(stderr).not.toContain("feature file not found");
  });

  it("still reports feature file not found for a file that genuinely does not exist", async () => {
    const { exitCode, stderr } = await check("features/does-not-exist.feature");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("feature file not found: features/does-not-exist.feature");
    // The new wording must not leak into the genuinely-missing case: a
    // constant "not supported" message would otherwise pass this suite by
    // always saying the same thing regardless of which problem occurred.
    expect(stderr).not.toContain(":line is not supported");
  });

  it("reports feature file not found (not the :line wording) when :line is given but the base file also does not exist", async () => {
    const { exitCode, stderr } = await check("features/does-not-exist.feature:9");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("feature file not found: features/does-not-exist.feature:9");
    expect(stderr).not.toContain(":line is not supported");
  });
});
