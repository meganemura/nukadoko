import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/run-cli.js";
import { isProcessAlive, readLockInfo } from "../src/session/lock.js";
import { sessionLockPath } from "../src/session/paths.js";
import { createCaptureSink, fixture, repoRoot } from "./helpers/fixtures.js";

// Responsibility: `nuka session start --idle-timeout` refuses a delay Node's
// own setTimeout cannot wait out, before a session process exists. yargs'
// `type: "number"` turns "abc" into NaN and accepts 0, a negative, and a
// value whose millisecond delay does not fit in a 32-bit signed integer.
// Node clamps each of those to 1 ms, so the daemon stops itself the moment
// it listens, and the only line the CLI has is that the process exited
// before it was ready. That line names neither the flag nor the limit.
//
// The project below is one a real `session start` accepts (the same shape
// as tests/live-session.test.ts). A directory that failed config load would
// fail this test for the wrong reason: the bug is a daemon that comes up
// and then exits, not a project that never loads.

const SESSION_NAME = "s";
const STATE_DIR = "s";

describe("nuka session start --idle-timeout", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createLiveSessionProject();
  });

  afterEach(async () => {
    const lockPath = sessionLockPath(rootDir, STATE_DIR, "default", SESSION_NAME);
    const info = await readLockInfo(lockPath).catch(() => null);
    if (info !== null && isProcessAlive(info.pid)) {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {
        // Already gone between the check and the signal.
      }
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  it.each(["abc", "0", "-1", "3000000", "2147484"])(
    "refuses %s before a session starts",
    async (value) => {
      const stdout = createCaptureSink();
      const stderr = createCaptureSink();
      const exitCode = await runCli(["session", "start", SESSION_NAME, "--idle-timeout", value], {
        rootDir,
        stdout,
        stderr,
      });

      expect(exitCode, stderr.text()).toBe(1);
      expect(stdout.text()).toBe("");
      expect(stderr.text()).toContain("--idle-timeout");
      expect(stderr.text()).toContain("2147483");
      expect(stderr.text()).toContain(`got ${value === "abc" ? "NaN" : value}`);
      expect(stderr.text()).not.toContain("exited before it was ready");
      expect(existsSync(sessionLockPath(rootDir, STATE_DIR, "default", SESSION_NAME))).toBe(false);
    },
  );
});

/** A copy of tests/fixtures/live-session-project that discovery can load
 * from outside this repository, the same construction as
 * tests/live-session.test.ts. The shim's committed relative path is only
 * correct at the fixture's own depth. */
async function createLiveSessionProject(): Promise<string> {
  const base = await realpath("/tmp");
  const dir = await mkdtemp(path.join(base, "nk-idle-"));
  await cp(fixture("live-session-project"), dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await symlink(path.join(repoRoot, "node_modules", "zod"), path.join(dir, "node_modules", "zod"), "dir");

  const target = path.join(repoRoot, "src", "index.js");
  let relative = path.relative(dir, target).split(path.sep).join("/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  await writeFile(path.join(dir, "nukadoko-shim.ts"), `export * from "${relative}";\n`);
  return dir;
}
