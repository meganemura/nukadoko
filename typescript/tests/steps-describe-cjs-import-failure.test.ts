import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { bySeverity } from "./helpers/envelope.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: the same CJS/.ts explanation
// tests/check-cjs-import-failure.test.ts already proves for `nuka check`
// also has to reach `nuka steps`/`nuka describe`. A project's first
// command is not always `check`, and both go through the same
// step-file-import-failed cause. Node's own "Cannot use import statement
// outside a module" is exactly as misleading on stderr here as it is in
// `check`'s own JSON report.

describe("nuka steps: CommonJS/.ts step-file-import-failed on stderr", () => {
  it("appends the CJS/.ts explanation when the project is CommonJS and the failed file is .ts", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps"], {
      rootDir: fixture("check-import-failure-cjs-project"),
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("Cannot use import statement outside a module");
    expect(stderr.text()).toContain('"type": "commonjs"');
    expect(stderr.text()).toContain("rename this file to .mts");
  });

  it("does not append anything when the project is not CommonJS, even for a .ts import failure (regression)", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps"], {
      rootDir: fixture("discover-import-failure-project"),
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("features/steps/broken.ts");
    expect(stderr.text()).not.toContain('"type": "commonjs"');
    expect(stderr.text()).not.toContain("rename this file to .mts");
  });
});

describe("nuka describe: CommonJS/.ts step-file-import-failed in its findings", () => {
  it("appends the CJS/.ts explanation on an unknown-step lookup, the same as a listed one", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["describe", "no-such-step"], {
      rootDir: fixture("check-import-failure-cjs-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    expect(exitCode).toBe(2);
    const failure = bySeverity(stdout.text()).errors.find((finding: { code: string }) => finding.code === "step-file-import-failed");
    expect(failure.message).toContain("Cannot use import statement outside a module");
    expect(failure.message).toContain('"type": "commonjs"');
    expect(failure.message).toContain("rename this file to .mts");
  });
});
