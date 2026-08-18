import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Responsibility: `nuka session start`'s own detached child — picking the
// right interpreter for daemon-entry.ts and turning "spawn it and return"
// into a bounded, honest wait for either its socket to appear or its own
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
// share (`<rootDir> <env|""> <name> <idleTimeoutSeconds>`), not something a
// user ever types.

export interface SpawnDaemonOptions {
  readonly rootDir: string;
  /** `--env`'s raw value, or `null` when it was omitted — carried through
   * unresolved so daemon.ts applies the exact same `resolveEnvironment`
   * call cli/do.ts's own setup phase does, rather than this module
   * re-deriving an environment name of its own. */
  readonly env: string | null;
  readonly name: string;
  readonly idleTimeoutSeconds: number;
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
  const { rootDir, env, name, idleTimeoutSeconds } = options;
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  const daemonEntry = path.join(path.dirname(here), `daemon-entry${ext}`);
  const args = [rootDir, env ?? "", name, String(idleTimeoutSeconds)];

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
 * Waits, bounded by `timeoutMs`, for one of three outcomes: the daemon's own
 * socket appears on disk (success — `daemon.ts` only creates it after
 * acquiring the lock and starting to listen), the child process exits or
 * errors first (a fast, precise failure — e.g. it lost the lock's own race,
 * or a config/discovery error it hit before ever opening a socket), or
 * neither happens before `timeoutMs` (a slower, less precise failure — the
 * child is presumably still alive but never got there).
 *
 * `stdio: "ignore"` (spawnDaemon, above) means the daemon can never write
 * *why* it failed anywhere this caller can read; this polling loop is the
 * only signal `nuka session start` gets that something went wrong at all
 * (CLAUDE.md "Nothing breaks silently" — a start that silently leaves no
 * live session and no error would be exactly that).
 */
export function waitForDaemonStartup(
  child: ChildProcess,
  sockPath: string,
  timeoutMs: number,
): Promise<DaemonStartupOk | DaemonStartupFailed> {
  return new Promise((resolve) => {
    let settled = false;

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
      if (existsSync(sockPath)) {
        finish({ ok: true });
      }
    }, 50);
    const timer = setTimeout(() => {
      finish({ ok: false, message: `the session did not become ready within ${timeoutMs}ms` });
    }, timeoutMs);
  });
}
