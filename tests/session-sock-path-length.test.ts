import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSessionStart } from "../src/cli/session.js";
import { LIVE_SOCK_DIR_PREFIX, LIVE_SOCK_FILE_NAME } from "../src/live/live-sock.js";
import { checkSockPathLength } from "../src/live/spawn-daemon.js";
import { sessionCrashLogPath, sessionLockPath } from "../src/session/paths.js";
import { createCaptureSink, fixture, repoRoot } from "./helpers/fixtures.js";

// Responsibility: the two behaviors a socket path over this platform's own
// `sun_path` limit needs (src/live/spawn-daemon.ts's own `checkSockPathLength`
// doc comment): `nuka session start` refuses before ever spawning a process
// (never a spawn that silently dies), and the daemon's own child, when it
// does die from an unnamed setup failure, leaves a reason somewhere a caller
// can read (daemon-entry.ts's own crash log).
//
// A live session's own socket lives under the OS's own temp directory now
// (live-sock.ts), never under this project, so neither a deep project path
// nor a long session name can push it over the limit any more — only a long
// `os.tmpdir()` still can. Both describe blocks below reach that the same
// way: overriding `process.env.TMPDIR` for the length of one test, since
// `os.tmpdir()` reads it fresh on every call. The second half drives
// daemon-entry.ts's own top-level script directly, in this same process,
// rather than through a real spawned subprocess — that describe block's own
// comment explains why a spawned one cannot reach the code this file exists
// to exercise, in this repository's own dev/test run.

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

describe("nuka session start: refuses a too-long live-session socket path before spawning", () => {
  let originalTmpdir: string | undefined;

  afterEach(async () => {
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
    }
    await rm(path.join(fixture("basic-project"), ".nukadoko"), { recursive: true, force: true });
  });

  it("exits 1, naming the predicted path, its byte length, and the platform limit", async () => {
    originalTmpdir = process.env.TMPDIR;
    // A long fake `TMPDIR` is the only thing left that can push a live
    // session's own socket path over this platform's own limit: it moved
    // out of this project entirely, so neither a deep project path nor a
    // long session name (this test's own condition before that move) can
    // reach it any more.
    process.env.TMPDIR = `/tmp/${"a".repeat(200)}`;

    const stdout = createCaptureSink();
    const stderr = createCaptureSink();
    const name = "alice";
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
    // The same prediction `runSessionStart` itself makes (cli/session.ts):
    // `mkdtemp` appends exactly six characters after `LIVE_SOCK_DIR_PREFIX`,
    // so any six-character stand-in predicts the real path's own byte
    // length exactly.
    const predictedSockPath = path.join(os.tmpdir(), `${LIVE_SOCK_DIR_PREFIX}XXXXXX`, LIVE_SOCK_FILE_NAME);
    expect(stderr.text()).toContain(predictedSockPath);
    expect(stderr.text()).toContain(`${Buffer.byteLength(predictedSockPath)} bytes`);
    const check = checkSockPathLength(predictedSockPath);
    expect(stderr.text()).toContain(`${check.limit}-byte limit`);

    // Refused before anything spawned: nothing at all under
    // cache/sessions/default/ for this name.
    expect(existsSync(sessionLockPath(fixture("basic-project"), ".nukadoko", "default", name))).toBe(false);
  });
});

/** Same short-path-project construction as tests/live-session.test.ts's own
 * `createLiveSessionProject`: a real project discovery can actually load,
 * kept short only so this test's own crash log file name stays well under a
 * real filesystem's own per-component name limit — `rootDir`'s own length
 * has nothing to do with the socket path any more (this file's own header
 * explains what does). */
async function createShortPathProject(): Promise<string> {
  const base = await realpath("/tmp");
  const dir = await mkdtemp(path.join(base, "nk-sockcrash-"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
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
    'import { defineConfig } from "./nukadoko-shim.js";\n' + 'export default defineConfig({ stateDir: "s" });\n',
  );
  await mkdir(path.join(dir, "features", "steps"), { recursive: true });
  await writeFile(
    path.join(dir, "features", "steps", "noop.ts"),
    'import { z } from "zod";\n' +
      'import { defineStep } from "../../nukadoko-shim.js";\n' +
      "export default defineStep({\n" +
      '  pattern: "noop happens",\n' +
      '  description: "does nothing",\n' +
      "  args: z.object({}),\n" +
      "  returns: z.object({}),\n" +
      "  mutates: false,\n" +
      "  async run() { return {}; },\n" +
      "});\n",
  );
  return dir;
}

/**
 * A real, already-existing directory long enough on its own that
 * `path.join(dir, mkdtemp's own 6 random chars, "live.sock")` overruns this
 * platform's own `sun_path` limit — `mkdtemp` has to succeed for `listen()`
 * to be the thing that fails with `EINVAL`, which is why this has to exist
 * on disk rather than merely be a long string (unlike the preflight test
 * above, which never reaches `mkdtemp` at all).
 */
async function createLongTmpdir(): Promise<string> {
  const base = await realpath("/tmp");
  const dir = await mkdtemp(path.join(base, "nk-longtmp-"));
  const padded = path.join(dir, "padding-directory-to-push-this-well-past-the-sun-path-limit-on-its-own");
  await mkdir(padded, { recursive: true });
  return padded;
}

describe("a live-session socket path that reaches the daemon itself: EINVAL leaves a readable crash log", () => {
  let rootDir: string | undefined;
  let longTmpdirRoot: string | undefined;
  let originalTmpdir: string | undefined;
  let originalArgv: string[] | undefined;
  let originalExitCode: number | string | undefined | null;

  afterEach(async () => {
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
    }
    if (originalArgv !== undefined) {
      process.argv = originalArgv;
    }
    // The test below drives daemon-entry.ts's own top-level script
    // in-process (its own comment explains why), which sets
    // `process.exitCode` the same way a real crashed daemon process would
    // right before it exits — reset here so a passing assertion does not
    // leak a nonzero exit code into this whole worker's own.
    process.exitCode = originalExitCode ?? undefined;
    if (rootDir !== undefined) {
      await rm(rootDir, { recursive: true, force: true });
    }
    if (longTmpdirRoot !== undefined) {
      await rm(longTmpdirRoot, { recursive: true, force: true });
    }
  });

  it("writes the real EINVAL to the crash log, at the path this session would actually bind to", async () => {
    rootDir = await createShortPathProject();
    const longTmpdir = await createLongTmpdir();
    // `createLongTmpdir`'s own return value sits one level inside the
    // mkdtemp'd directory it made; removing that outer one removes both.
    longTmpdirRoot = path.dirname(longTmpdir);
    originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = longTmpdir;

    const name = "alice";
    const crashLogPath = sessionCrashLogPath(rootDir, "s", "default", name);

    // Not `spawnDaemon` here, on purpose: this repository's own dev/test
    // run spawns daemon-entry.ts through tsx's own CLI (spawn-daemon.ts's
    // own header), and tsx's own bootstrap creates its own IPC pipe under
    // `os.tmpdir()` before daemon-entry.ts ever loads — measured directly
    // while writing this test, a long `TMPDIR` makes *that* pipe hit the
    // exact same `EINVAL` first, for a path this package's own code never
    // touches, so a spawned child never reaches the code this test exists
    // to exercise at all. daemon-entry.ts is a plain top-level script, not
    // an exported function (its own header: argv-driven on purpose, never
    // part of nukadoko's own CLI surface), so it is driven the same way
    // here: faking `process.argv` and importing it directly, in this same
    // process, which reaches its own top-level `try`/`catch` without going
    // through tsx's CLI at all.
    originalArgv = process.argv;
    process.argv = ["node", "daemon-entry.ts", rootDir, "", name, "60", crashLogPath];
    originalExitCode = process.exitCode;
    await import("../src/live/daemon-entry.js");
    // The `catch` block's own `writeFile` is awaited before the module's
    // top-level execution finishes, so there is nothing left to poll for.

    expect(process.exitCode).toBe(1);
    expect(existsSync(crashLogPath)).toBe(true);
    const crashLog = await readFile(crashLogPath, "utf8");
    expect(crashLog).toContain("EINVAL");
  });
});
