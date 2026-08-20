import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, createEmptyTempDir, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the same "yargs' own .fail() sets argsFailed, then still
// runs the matched handler, whose own `if (argsFailed) return;` guard is
// what actually stops it" shape tests/run-cli-wiring-refusals.test.ts
// already proves for harvest/accept/session list/start/stop, extended
// here to the nine remaining commands that guard reaches: steps, describe,
// init, scaffold, check, tend, skill path, mcp-tools, and experimental
// webmcp-tools. Kept in its own file (a new file, not an edit to that one)
// so the two never collide on the same lines.

describe("nuka <command> --unknown-flag: the matched handler never runs (remaining commands)", () => {
  it("nuka steps: prints nothing", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["steps", "--unknown-flag"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
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

    expect(exitCode).toBe(1);
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

      expect(exitCode).toBe(1);
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

      expect(exitCode).toBe(1);
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

    expect(exitCode).toBe(1);
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

    expect(exitCode).toBe(1);
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

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("unknown-flag");
    expect(stdout.text()).toBe("");
  });

  it("nuka mcp-tools: never connects to a server", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["mcp-tools", "--unknown-flag"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("unknown-flag");
    expect(stdout.text()).toBe("");
  });

  it("nuka experimental webmcp-tools: never launches a browser", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(
      ["experimental", "webmcp-tools", "http://example.com/", "--unknown-flag"],
      { rootDir: fixture("basic-project"), stdout, stderr },
    );

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("unknown-flag");
    expect(stdout.text()).toBe("");
  });
});
