import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { createCaptureSink, fixture } from "./helpers/fixtures.js";

// Responsibility: end-to-end tests —
// `nuka steps`/`nuka describe` are per-file tolerant of a broken glue file
// (decision 1) and of a step whose `run()` can't be statically read for its
// fixture needs (decision 2), unlike `run`/`do`/`init`, which stay
// fail-fast on purpose (those are about to execute; `steps`/`describe`
// only report). `run`/`do`/`init` are out of this file's own ownership and
// untouched.

describe("nuka steps: tolerant of a broken glue file", () => {
  it("still lists the healthy step, names the broken file on stderr, and exits 1", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps"], {
      rootDir: fixture("discover-import-failure-project"),
      stdout,
      stderr,
    });

    expect(stdout.text()).toContain("healthy");
    expect(stderr.text()).toContain("features/steps/broken.ts");
    expect(stderr.text()).toContain("require is not defined");
    expect(exitCode).toBe(1);
  });

  it("--json: reports import_failures as { file, message } alongside every step that did import", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("discover-import-failure-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as {
      steps: Array<{ name: string }>;
      import_failures: Array<{ file: string; message: string }>;
    };
    expect(report.steps.map((s) => s.name)).toEqual(["healthy"]);
    expect(report.import_failures).toHaveLength(1);
    expect(report.import_failures[0]?.file).toBe("features/steps/broken.ts");
    expect(report.import_failures[0]?.message).toContain("require is not defined");
    expect(exitCode).toBe(1);
  });

  it("--json: import_failures is an empty array, not omitted, when nothing failed; exits 0", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as { import_failures: unknown[] };
    expect(report.import_failures).toEqual([]);
    expect(exitCode).toBe(0);
  });
});

describe("nuka steps: a step whose run() can't be read for fixture needs", () => {
  it("still lists every other step, and marks only the unreadable one with needs: null + needs_error", async () => {
    const stdout = createCaptureSink();
    const exitCode = await runCli(["steps", "--json"], {
      rootDir: fixture("fixture-bag-project"),
      stdout,
      stderr: createCaptureSink(),
    });

    const report = JSON.parse(stdout.text()) as {
      steps: Array<{ name: string; needs?: unknown; needs_error?: string }>;
    };
    const names = report.steps.map((s) => s.name);
    // clean-step.ts's own run() parses fine; default-value-step.ts's does
    // not (a destructured fixture with a default value) —
    // the one broken step must not take the healthy one down with it.
    expect(names).toContain("clean-step");
    expect(names).toContain("default-value-step");

    const clean = report.steps.find((s) => s.name === "clean-step");
    expect(clean?.needs).toEqual(["env", "page"]);
    expect(clean?.needs_error).toBeUndefined();

    const broken = report.steps.find((s) => s.name === "default-value-step");
    expect(broken?.needs).toBeNull();
    expect(broken?.needs_error).toContain("default value");
    expect(exitCode).toBe(1);
  });
});

describe("nuka describe: tolerant of a broken glue file", () => {
  it("still describes the healthy step, names the broken file on stderr, and exits 1", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "healthy"], {
      rootDir: fixture("discover-import-failure-project"),
      stdout,
      stderr,
    });

    const contract = JSON.parse(stdout.text()) as {
      name: string;
      import_failures: Array<{ file: string; message: string }>;
    };
    expect(contract.name).toBe("healthy");
    expect(contract.import_failures).toHaveLength(1);
    expect(contract.import_failures[0]?.file).toBe("features/steps/broken.ts");
    expect(stderr.text()).toContain("features/steps/broken.ts");
    expect(exitCode).toBe(1);
  });

  it("an unknown step name still names the broken file on stderr (it may be exactly why the step is unknown)", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "no-such-step"], {
      rootDir: fixture("discover-import-failure-project"),
      stdout,
      stderr,
    });

    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Unknown step: no-such-step");
    expect(stderr.text()).toContain("features/steps/broken.ts");
    expect(exitCode).toBe(1);
  });
});
