import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionStart } from "../src/cli/session.js";
import { checkSockPathLength, spawnDaemon, waitForDaemonStartup } from "../src/live/spawn-daemon.js";
import { isProcessAlive } from "../src/session/lock.js";
import { sessionCrashLogPath, sessionLockPath, sessionSockPath } from "../src/session/paths.js";
import { createCaptureSink, fixture, repoRoot } from "./helpers/fixtures.js";

// Responsibility: the two behaviors a socket path over this platform's own
// `sun_path` limit needs (src/live/spawn-daemon.ts's own `checkSockPathLength`
// doc comment): `nuka session start` refuses before ever spawning a process
// (never a spawn that silently dies), and the daemon's own child, when it
// does die from an unnamed setup failure, leaves a reason somewhere a caller
// can read (daemon-entry.ts's own crash log). The second half is tested by
// calling `spawnDaemon`/`waitForDaemonStartup` directly, deliberately
// bypassing `runSessionStart`'s own new refusal — that refusal, by design,
// would otherwise stop the very EINVAL this half of the file exists to
// prove gets a reason written down.

describe("checkSockPathLength", () => {
  // `limit` itself is read off an empty-string probe rather than
  // hardcoded, so these assertions hold on every platform this check runs
  // on (104 on macOS/BSD, 108 on Linux — the function's own doc comment),
  // not only the one this test happened to run on.
  const { limit } = checkSockPathLength("");

  it("accepts a path exactly at this platform's own limit", () => {
    const atLimit = "/tmp/" + "a".repeat(limit - "/tmp/".length);
    const result = checkSockPathLength(atLimit);
    expect(result.byteLength).toBe(limit);
    expect(result.ok).toBe(true);
  });

  it("refuses a path one byte over this platform's own limit", () => {
    const overLimit = "/tmp/" + "a".repeat(limit - "/tmp/".length + 1);
    const result = checkSockPathLength(overLimit);
    expect(result.byteLength).toBe(limit + 1);
    expect(result.ok).toBe(false);
    expect(result.limit).toBe(limit);
  });
});

describe("nuka session start: refuses a too-long socket path before spawning", () => {
  it("exits 1, naming the path, its byte length, and the platform limit", async () => {
    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    // No length cap on a session name (src/session/name.ts) — long enough on
    // its own to push cache/sessions/default/<name>.sock over any real
    // platform's own sun_path limit, regardless of where this repository's
    // own checkout happens to sit.
    const name = "a".repeat(300);
    const exitCode = await runSessionStart({
      rootDir: fixture("basic-project"),
      name,
      env: null,
      idleTimeoutSeconds: 60,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    const expectedSockPath = sessionSockPath(fixture("basic-project"), ".nukadoko", "default", name);
    expect(stderr.text()).toContain(expectedSockPath);
    expect(stderr.text()).toContain(`${Buffer.byteLength(expectedSockPath)} bytes`);
    const check = checkSockPathLength(expectedSockPath);
    expect(stderr.text()).toContain(`${check.limit}-byte limit`);

    // Refused before anything spawned: nothing at all under
    // cache/sessions/default/ for this name.
    expect(existsSync(sessionLockPath(fixture("basic-project"), ".nukadoko", "default", name))).toBe(false);
    expect(existsSync(expectedSockPath)).toBe(false);

    await rm(path.join(fixture("basic-project"), ".nukadoko"), { recursive: true, force: true });
  });
});

describe("a socket path that reaches the daemon itself: EINVAL leaves a readable crash log", () => {
  let rootDir: string | undefined;
  let pid: number | undefined;

  afterEach(async () => {
    if (pid !== undefined && isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone between the check and the signal — fine.
      }
    }
    if (rootDir !== undefined) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  /** Same short-path-project construction as tests/live-session.test.ts's
   * own `createLiveSessionProject` (that file's own header explains why a
   * plain nested tests/.tmp-fixtures/... copy will not do): this project's
   * own root has to stay short, since the point of this test is a socket
   * path that overruns the platform limit *because of the session name
   * alone*, not because of where the project happens to live. */
  async function createShortPathProject(): Promise<string> {
    const base = await realpath("/tmp");
    const dir = await mkdtemp(path.join(base, "nk-sockcrash-"));
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify({ type: "module" }, null, 2)}\n`,
    );
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await symlink(path.join(repoRoot, "node_modules", "zod"), path.join(dir, "node_modules", "zod"), "dir");

    const shimTarget = path.join(repoRoot, "src", "index.js");
    let relative = path.relative(dir, shimTarget).split(path.sep).join("/");
    if (!relative.startsWith(".")) {
      relative = `./${relative}`;
    }
    await writeFile(path.join(dir, "nukadoko-shim.ts"), `export * from "${relative}";\n`);
    await writeFile(
      path.join(dir, "nukadoko.config.ts"),
      'import { defineConfig } from "./nukadoko-shim.js";\n' +
        'export default defineConfig({ stateDir: "s" });\n',
    );
    await mkdir(path.join(dir, "features", "steps"), { recursive: true });
    await writeFile(
      path.join(dir, "features", "steps", "noop.ts"),
      'import { z } from "zod";\n' +
        'import { defineStep } from "../../nukadoko-shim.js";\n' +
        'export default defineStep({\n' +
        '  pattern: "noop happens",\n' +
        '  description: "does nothing",\n' +
        '  args: z.object({}),\n' +
        '  returns: z.object({}),\n' +
        '  mutates: false,\n' +
        '  async run() { return {}; },\n' +
        '});\n',
    );
    return dir;
  }

  it("writes the real EINVAL to the crash log, at the path session start would name", async () => {
    rootDir = await createShortPathProject();
    // Long enough that cache/sessions/default/<name>.sock overruns this
    // platform's own sun_path limit even though `rootDir` itself is short
    // (the one condition this test needs `spawnDaemon`'s own real child to
    // hit `listen()`'s own EINVAL, deliberately reached by calling
    // `spawnDaemon`/`waitForDaemonStartup` directly rather than through
    // `runSessionStart`, whose own new refusal, tested above, would
    // otherwise stop this before it ever spawns) — short enough that the
    // crash log's own file name (`<name>.crash.log`) still fits under a
    // real filesystem's own per-component name limit (measured 255 bytes
    // on this machine's APFS), a *different* length ceiling from
    // `sun_path`'s, which a name long enough to reliably overrun the first
    // one already clears several times over.
    const name = "b".repeat(120);
    const crashLogPath = sessionCrashLogPath(rootDir, "s", "default", name);
    const sockPath = sessionSockPath(rootDir, "s", "default", name);

    const child = spawnDaemon({ rootDir, env: null, name, idleTimeoutSeconds: 60, crashLogPath });
    pid = child.pid;
    const outcome = await waitForDaemonStartup(child, sockPath, 15_000);

    expect(outcome.ok).toBe(false);
    expect(existsSync(crashLogPath)).toBe(true);
    const crashLog = await readFile(crashLogPath, "utf8");
    expect(crashLog).toContain("EINVAL");
  }, 20_000);
});
