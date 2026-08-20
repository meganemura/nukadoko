import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: two shapes of run-cli.ts's own wiring that session.test.ts
// already proves for `session clear` (its own "an unknown flag fails
// setup" case) but no test yet proves for the other commands. yargs'
// `.fail()` sets `argsFailed`, then still runs the matched handler, whose
// own `if (argsFailed) return;` guard is what actually stops it: the same
// mechanism, one line per command, checked here for the commands this
// package's own test suite is otherwise thinnest on. Also `nuka describe`'s
// own ConfigError propagation, which `nuka steps`' sibling test
// (cli.test.ts) already proves for `steps` but not for `describe`.

describe("nuka <command> --unknown-flag: the matched handler never runs", () => {
  it("nuka harvest: writes nothing and never reads any step record", async () => {
    const rootDir = await copyFixtureToTempDir("harvest-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["harvest", "whatever-id", "--unknown-flag"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stderr.text()).toContain("unknown-flag");
      expect(stdout.text()).toBe("");
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("nuka accept: writes no acceptance record", async () => {
    const rootDir = await copyFixtureToTempDir("accept-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(
        ["accept", "features/greeting.feature", "--unknown-flag"],
        { rootDir, stdout, stderr },
      );

      expect(exitCode).toBe(1);
      expect(stderr.text()).toContain("unknown-flag");
      const entries = await readdir(path.join(rootDir, "features"));
      expect(entries.filter((name) => name.endsWith(".md"))).toEqual([]);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("nuka session list: prints nothing", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "list", "--unknown-flag"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("unknown-flag");
    expect(stdout.text()).toBe("");
  });

  it("nuka session start: never spawns a daemon", async () => {
    const rootDir = await copyFixtureToTempDir("basic-project");
    try {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["session", "start", "alice", "--unknown-flag"], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode).toBe(1);
      expect(stderr.text()).toContain("unknown-flag");
      expect(existsSync(`${rootDir}/.nukadoko`)).toBe(false);
    } finally {
      await removeTempDir(rootDir);
    }
  });

  it("nuka session stop: leaves any lock/socket untouched", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "stop", "alice", "--unknown-flag"], {
      rootDir: fixture("basic-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stderr.text()).toContain("unknown-flag");
    expect(stdout.text()).toBe("");
  });
});

describe("nuka describe: config load failure", () => {
  it("propagates a ConfigError as exit 1 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["describe", "some-step"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("typo");
  });
});
