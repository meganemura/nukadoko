import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, createEmptyTempDir, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: yargs' own .fail() sets argsFailed, then still runs the
// matched handler, whose own `if (argsFailed) return;` guard is what
// actually stops it. Checked for each command that guard reaches: steps,
// describe, init, scaffold, check, tend, and skill path.

describe("nuka <command> --unknown-flag: the matched handler never runs (remaining commands)", () => {
  it("nuka steps: prints nothing", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps", "--unknown-flag"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("unknown-flag");
    expect(stdout.text()).toBe("");
  });

  it("nuka describe: prints nothing", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "list-projects", "--unknown-flag"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("unknown-flag");
    expect(stdout.text()).toBe("");
  });

  it("nuka init: writes no nukadoko.config.ts", async () => {
    const rootDir = await createEmptyTempDir();
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["init", "--unknown-flag"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(2);
      expect(stderr.text()).toContain("unknown-flag");
      expect(existsSync(path.join(rootDir, "nukadoko.config.ts"))).toBe(false);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("nuka scaffold: writes no step file", async () => {
    const rootDir = await copyFixtureToTempDir("basic-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["scaffold", "brand-new-step", "--unknown-flag"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(2);
      expect(stderr.text()).toContain("unknown-flag");
      expect(existsSync(path.join(rootDir, "features", "steps", "brand-new-step.ts"))).toBe(false);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("nuka check: prints nothing", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["check", "--unknown-flag"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("unknown-flag");
    expect(stdout.text()).toBe("");
  });

  it("nuka tend: prints nothing", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["tend", "--unknown-flag"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("unknown-flag");
    expect(stdout.text()).toBe("");
  });

  it("nuka skill path: prints nothing", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["skill", "path", "--unknown-flag"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("unknown-flag");
    expect(stdout.text()).toBe("");
  });
});
