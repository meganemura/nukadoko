import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: the same CJS/.ts explanation
// tests/check-cjs-import-failure.test.ts already proves for `nuka check`
// also has to reach `nuka steps`/`nuka describe`. A project's first
// command is not always `check`, and both go through the same
// step-file-import-failed cause. Node's own "Cannot find module
// '<path>?namespace=<uuid>'" is exactly as misleading on stderr here as it
// is in `check`'s own JSON report.

describe("nuka steps: CommonJS/.ts step-file-import-failed on stderr", () => {
  it("appends the CJS/.ts explanation when the project is CommonJS and the failed file is .ts", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps"], {
      rootDir: fixture("check-import-failure-cjs-project"),
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("Cannot find module");
    expect(stderr.text()).toContain('"type": "module"');
    expect(stderr.text()).toContain(".mts");
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
    expect(stderr.text()).not.toContain('"type": "module"');
    expect(stderr.text()).not.toContain(".mts");
  });
});

describe("nuka describe: CommonJS/.ts step-file-import-failed on stderr", () => {
  it("appends the CJS/.ts explanation on an unknown-step lookup, the same as a listed one", async () => {
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "no-such-step"], {
      rootDir: fixture("check-import-failure-cjs-project"),
      stdout: createCaptureSink(),
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("Cannot find module");
    expect(stderr.text()).toContain('"type": "module"');
    expect(stderr.text()).toContain(".mts");
  });
});
