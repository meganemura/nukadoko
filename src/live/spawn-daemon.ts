import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { liveLockOwner } from "../session/lock.js";

// Responsibility: `nuka session start`'s own detached child — picking the
// right interpreter for daemon-entry.ts and turning "spawn it and return"
// into a bounded, honest wait for either its socket to become reachable
// (read from this session's own lock, not a path this module derives
// itself — the daemon's socket lives under the OS's own temp directory now,
// picked by its own `mkdtemp` call, live-sock.ts's own header) or its own
// early death, per `SpawnDaemonOptions`'s and `waitForDaemonStartup`'s own
// doc comments below.
//
// daemon-entry.ts's own extension (`.ts` here, in this repository's own
// dev/test run; `.js` once tsconfig.build.json has mirrored `src/` onto
// `dist/`) is read off *this* module's own `import.meta.url` — the same
// "two layouts have to both work" problem, and the same fix, as src/cli/
// skill.ts's own header explains for locating a package resource from
// either one. tsx is nukadoko's own direct dependency (package.json), so
// `<package root>/node_modules/.bin/tsx` exists whether nukadoko is this
// repository itself or a downstream project's `node_modules/nukadoko`
// — the same reasoning cli.test.ts's own `tsxBin` already relies on for
// spawning `nuka` as a real subprocess in a test.
//
// This entry point is never part of nukadoko's own CLI surface — argv here
// is a private, positional contract this file and daemon-entry.ts alone
// share (`<rootDir> <env|""> <name> <idleTimeoutSeconds> <crashLogPath>`),
// not something a user ever types.

export interface SpawnDaemonOptions {
  readonly rootDir: string;
  /** `--env`'s raw value, or `null` when it was omitted — carried through
   * unresolved so daemon.ts applies the exact same `resolveEnvironment`
   * call cli/do.ts's own setup phase does, rather than this module
   * re-deriving an environment name of its own. */
  readonly env: string | null;
  readonly name: string;
  readonly idleTimeoutSeconds: number;
  /** Where daemon-entry.ts writes the reason if it dies before ever
   * opening a socket (its own header, and `checkSockPathLength`'s own doc
   * comment below, explain why this process otherwise has nowhere to
   * report that at all). Computed by the caller (`sessionCrashLogPath`,
   * src/session/paths.ts) rather than re-derived here, the same split this
   * module already keeps for the socket/lock paths. */
  readonly crashLogPath: string;
}

function packageRoot(here: string): string {
  return path.resolve(path.dirname(here), "..", "..");
}

/**
 * Spawns this session's own daemon, detached (`detached: true`, `stdio:
 * "ignore"`, `unref()`'d immediately) so the caller's own process can exit
 * the instant it has confirmed the daemon is up (`waitForDaemonStartup`,
 * below) without keeping it alive as a child.
 */
export function spawnDaemon(options: SpawnDaemonOptions): ChildProcess {
  const { rootDir, env, name, idleTimeoutSeconds, crashLogPath } = options;
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  const daemonEntry = path.join(path.dirname(here), `daemon-entry${ext}`);
  const args = [rootDir, env ?? "", name, String(idleTimeoutSeconds), crashLogPath];

  const child =
    ext === ".ts"
      ? spawn(path.join(packageRoot(here), "node_modules", ".bin", "tsx"), [daemonEntry, ...args], {
          detached: true,
          stdio: "ignore",
        })
      : spawn(process.execPath, [daemonEntry, ...args], {
          detached: true,
          stdio: "ignore",
        });
  child.unref();
  return child;
}

export interface DaemonStartupOk {
  readonly ok: true;
}

export interface DaemonStartupFailed {
  readonly ok: false;
  readonly message: string;
}

/**
 * Waits, bounded by `timeoutMs`, for one of three outcomes: this session's
 * own lock names a socket that actually exists on disk (success — the lock
 * only ever names one once `daemon.ts` has acquired the lock, and the
 * socket file itself only exists once `listen()` has actually succeeded
 * against it, so this is the same "acquired the lock and started to
 * listen" guarantee the pre-mkdtemp version of this check made against a
 * predictable path, just read from the lock now that the path is not one),
 * the child process exits or errors first (a fast, precise failure — e.g.
 * it lost the lock's own race, or a config/discovery error it hit before
 * ever opening a socket), or neither happens before `timeoutMs` (a slower,
 * less precise failure — the child is presumably still alive but never got
 * there).
 *
 * `stdio: "ignore"` (spawnDaemon, above) means the daemon can never write
 * *why* it failed anywhere this caller can read; this polling loop is the
 * only signal `nuka session start` gets that something went wrong at all
 * (CLAUDE.md "Nothing breaks silently" — a start that silently leaves no
 * live session and no error would be exactly that).
 */
export function waitForDaemonStartup(
  child: ChildProcess,
  lockPath: string,
  timeoutMs: number,
): Promise<DaemonStartupOk | DaemonStartupFailed> {
  return new Promise((resolve) => {
    let settled = false;
    // Guards against two `liveLockOwner` reads overlapping if one read
    // (a file read plus a `kill(pid, 0)`) ever takes longer than one
    // `setInterval` tick — unlikely at 50ms, but a stray unresolved promise
    // outliving `finish` below is worse than one skipped tick.
    let polling = false;

    function finish(result: DaemonStartupOk | DaemonStartupFailed): void {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(result);
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      finish({
        ok: false,
        message: `the session process exited before it was ready (code ${code}, signal ${signal})`,
      });
    }
    function onError(error: Error): void {
      finish({ ok: false, message: error.message });
    }

    child.once("exit", onExit);
    child.once("error", onError);

    const poll = setInterval(() => {
      if (settled || polling) {
        return;
      }
      polling = true;
      void liveLockOwner(lockPath)
        .then((owner) => {
          if (owner?.sock !== undefined && existsSync(owner.sock)) {
            finish({ ok: true });
          }
        })
        .finally(() => {
          polling = false;
        });
    }, 50);
    const timer = setTimeout(() => {
      finish({ ok: false, message: `the session did not become ready within ${timeoutMs}ms` });
    }, timeoutMs);
  });
}

// The unix domain socket `sun_path` buffer a live session's own socket path
// (live-sock.ts's own `LIVE_SOCK_DIR_PREFIX`/`LIVE_SOCK_FILE_NAME`, joined
// to `os.tmpdir()`) has to fit inside, in bytes. Measured directly on
// macOS, in this repository's own dev
// environment, rather than assumed: `net.createServer().listen()` against a
// generated path succeeds up to 104 bytes and fails with `EINVAL` at 105 —
// the same "declaration and measurement answer different questions" split
// this repository's own CLAUDE.md states for project config applies here to
// a platform constant. Linux's own limit is wider (`sizeof(sun_path)` in
// the kernel's own `include/uapi/linux/un.h`) and is not measured here —
// this package has no Linux machine to measure on — so it is cited from
// that header instead and named as a citation, not presented as equally
// certain. Every other Node platform this constant might run on (the BSDs)
// shares macOS's own BSD sockets lineage closely enough to use the same
// value; nothing here claims that for Windows, whose own `AF_UNIX` support
// is a separate, much newer addition this package has not measured either.
const MAX_SOCK_PATH_BYTES_LINUX = 108;
const MAX_SOCK_PATH_BYTES_BSD_DERIVED = 104;

export interface SockPathLengthCheck {
  readonly ok: boolean;
  readonly byteLength: number;
  readonly limit: number;
}

/**
 * Checks `sockPath` against this platform's own `sun_path` limit. `cli/
 * session.ts`'s own preflight calls this *before* anything spawns a
 * process to bind it, against the exact byte length the real path will
 * have once `mkdtemp` fills in its own six-character suffix (live-sock.ts):
 * `spawnDaemon`'s own child has no terminal to report `EINVAL` to
 * (spawn-daemon.ts's own header), so refusing here, loudly, from the one
 * process that still has a caller to report to, is strictly better than
 * waiting for that same failure to surface as an unexplained non-zero exit
 * (this file's own `waitForDaemonStartup`) with the real reason nowhere a
 * user can read it. Generic on its own `sockPath` argument rather than
 * hard-coded to that one shape, so this stays testable against an arbitrary
 * path independent of whatever `cli/session.ts` predicts.
 */
export function checkSockPathLength(sockPath: string): SockPathLengthCheck {
  const limit = process.platform === "linux" ? MAX_SOCK_PATH_BYTES_LINUX : MAX_SOCK_PATH_BYTES_BSD_DERIVED;
  const byteLength = Buffer.byteLength(sockPath);
  return { ok: byteLength <= limit, byteLength, limit };
}
