import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { copyFixtureToTempDir, createCaptureSink, fixture, removeTempDir } from "./helpers/fixtures.js";

// Responsibility: the refusal branches of `nuka session list/clear`
// (src/cli/session.ts) that session.test.ts, which drives a real
// `do --session` call, never reaches: bad config, bad name, unknown --env.
// Also the refusal the removed `session start`/`stop` spellings give.

function sessionsDir(rootDir: string, environment = "default"): string {
  return path.join(rootDir, ".nukadoko", "cache", "sessions", environment);
}

describe("nuka session list: setup failure", () => {
  it("propagates a config load failure as exit 2 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "list"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("typo");
    expect(stdout.text()).toBe("");
  });
});

describe("nuka session clear: setup failures", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await copyFixtureToTempDir("session-project");
  });

  afterEach(async () => {
    await removeTempDir(rootDir);
  });

  it("rejects an invalid --env name before touching any session file", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "clear", "--env", "Not Valid!"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).not.toBe("");
    expect(stdout.text()).toBe("");
  });

  it("propagates a config load failure as exit 2 with a stderr message", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "clear"], {
      rootDir: fixture("invalid-config-project"),
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toContain("typo");
  });

  it("refuses an unknown --env when that environment has no session files", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "clear", "--env", "stagign"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe(
      'Unknown environment "stagign": not defined in nukadoko.config.ts\'s "environments"\ndo: nuka session clear --help\n',
    );
    expect(stdout.text()).toBe("");
  });

  it("refuses an unknown --env before reporting a missing session name", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "clear", "alice", "--env", "stagign"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe(
      'Unknown environment "stagign": not defined in nukadoko.config.ts\'s "environments"\ndo: nuka session clear --help\n',
    );
    expect(stdout.text()).toBe("");
  });

  it("clears session files left under an environment the config no longer defines, and names it", async () => {
    const dir = sessionsDir(rootDir, "retired");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "left.json"), JSON.stringify({ cookies: [], origins: [] }));

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "clear", "--env", "retired"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe(
      'Environment "retired" is not defined in nukadoko.config.ts\'s "environments"; clearing the sessions left under it\n',
    );
    expect(stdout.text()).toBe("");
    expect(existsSync(path.join(dir, "left.json"))).toBe(false);
  });

  it("stays silent when --env is omitted, even if environments.default is undefined", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "clear"], {
      rootDir,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toBe("");
  });
});

describe("nuka session start and stop, removed", () => {
  it("exits 2 and names `nuka do --session` and the upgrading note", async () => {
    for (const argv of [["session", "start", "alice"], ["session", "stop", "alice", "--env", "staging"]]) {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(argv, { rootDir: fixture("basic-project"), stdout, stderr });

      expect(exitCode).toBe(2);
      expect(stderr.text()).toBe(
        `\`nuka session ${argv[1]}\` was removed with live sessions; \`nuka do <step> --session <name>\` still carries ` +
          "login state across calls, and a page whose state cannot be repeated is explored through a Playwright " +
          "MCP server (see docs/upgrading.md in the nukadoko package)\n" +
          "do: nuka do --help\n",
      );
      expect(stdout.text()).toBe("");
    }
  });

  it("refuses as one JSON object under --json", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const exitCode = await runCli(["session", "start", "alice", "--json"], { rootDir: fixture("basic-project"), stdout, stderr });

    expect(exitCode).toBe(2);
    expect(stderr.text()).toBe("");
    const refusal = JSON.parse(stdout.text()) as { error: string; do: string };
    expect(refusal.do).toBe("nuka do --help");
    expect(refusal.error.startsWith("`nuka session start` was removed with live sessions;")).toBe(true);
  });
});
