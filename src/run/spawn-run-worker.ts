import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { loaderUrl } from "../config/ts-loader.js";

// Responsibility: turns "run run-worker-entry.ts against this argument
// list" into an actual child process the parent keeps (never unref'd:
// `nuka run --concurrency <n>` waits for every worker to finish before it can print
// its own summary and exit, so the parent must keep each worker as a real
// child it can await, not one it hands off and forgets).
//
// run-worker-entry.ts's own file extension, read off *this* module's own
// `import.meta.url`, is `.ts` in this repository's own dev/test run and
// `.js` once tsconfig.build.json has mirrored `src/` onto `dist/`. The
// `.ts` case preloads src/config/ts-loader.ts with `--import`, because
// `src/` imports its own `.ts` files by their `.js` names and the loader's
// resolve hook has to be in place before the entry's first import.
//
// `stdio: ["ignore", "pipe", "pipe", "ipc"]`. stdin is empty, so a step
// that reads it gets end of file at once, as it would with no terminal.
// The IPC channel carries no message; it closes when the parent is gone,
// however it went (SIGKILL, a killed process group), and the worker treats
// its `disconnect` as the parent's death (run-worker-entry.ts). It is the
// IPC channel and not stdin because project code reads, pauses, and
// destroys stdin, and any of those would hide the parent's death or hang a
// step. It is not an extra pipe on fd 3 either: Node closes the IPC channel
// the same way on every platform, and a worker would have to open fd 3 by
// number. stdout carries this worker's own envelope stream
// (src/run/worker-protocol.ts), stderr is kept for whatever Node itself
// writes there before this worker's own try/catch exists to turn a failure
// into an envelope instead, and for project code's own stdout writes (that
// module's own header explains the split).

export interface SpawnRunWorkerOptions {
  readonly rootDir: string;
  readonly runId: string;
  /** `--env`'s raw value, or `null` when it was omitted, so
   * run-worker-entry.ts applies the exact same `resolveEnvironment` call
   * `nuka run` itself does rather than trusting a name this module resolved
   * on the parent's behalf. */
  readonly env: string | null;
  /** Absolute path to a temp file, one repo-relative `.feature` path per
   * line, in the order this worker should run them (src/run/worker-
   * protocol.ts's own argv contract). */
  readonly featureListPath: string;
  /** `--repeat`: how many times this worker runs its own files. */
  readonly repeat: number;
  /** Absolute path to a temp file holding the pass's world
   * (src/program/world-view.ts), or `null` when the pass has none. */
  readonly worldPath: string | null;
}

// `detached` on POSIX puts each worker in its own process group, so a
// terminal's Ctrl-C or hangup reaches only the parent, which forwards it
// once (src/run/run-concurrent.ts). A worker that also got the terminal's
// copy would count the forwarded one as a second signal and exit without
// teardown. On Windows `detached` opens a console window, and the parent
// does not forward: every process on the console already gets Ctrl-C, and
// `child.kill` there is TerminateProcess, which would end a worker in the
// middle of its teardown.
const detached = process.platform !== "win32";

export function spawnRunWorker(options: SpawnRunWorkerOptions): ChildProcessByStdio<null, Readable, Readable> {
  const { rootDir, runId, env, featureListPath, repeat, worldPath } = options;
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  const workerEntry = path.join(path.dirname(here), `run-worker-entry${ext}`);
  const args = [rootDir, runId, env ?? "", featureListPath, String(repeat), worldPath ?? ""];
  const nodeArgs =
    ext === ".ts" ? ["--import", loaderUrl, workerEntry] : [workerEntry];

  // `spawn`'s stdio-tuple overloads stop at three entries, so the fourth
  // ("ipc") drops the return type to a plain ChildProcess.
  return spawn(process.execPath, [...nodeArgs, ...args], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached,
  }) as ChildProcessByStdio<null, Readable, Readable>;
}
