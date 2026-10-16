import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

// Responsibility: turns "run run-worker-entry.ts against this argument
// list" into an actual child process the parent keeps (never unref'd,
// unlike src/live/spawn-daemon.ts's own session daemon: `nuka run
// --concurrency <n>` waits for every worker to finish before it can print
// its own summary and exit, so the parent must keep each worker as a real
// child it can await, not one it hands off and forgets).
//
// run-worker-entry.ts's own file extension, read off *this* module's own
// `import.meta.url`, is `.ts` in this repository's own dev/test run and
// `.js` once tsconfig.build.json has mirrored `src/` onto `dist/`. The
// `.ts` case runs under Node with tsx's loader (nukadoko's own direct
// dependency) given to `--import`, never through the `tsx` command: that
// command is a second process between the parent and the worker, and it
// relays only SIGINT and SIGTERM.
//
// `stdio: ["pipe", "pipe", "pipe"]`: the parent never writes to stdin, and
// stdin ends when the parent is gone, however it went (SIGKILL, a killed
// process group). The worker treats that end as its first signal and tears
// its fixtures down (run-worker-entry.ts). stdout carries this worker's own
// envelope stream (src/run/worker-protocol.ts), stderr is kept for
// whatever Node itself writes there before this worker's own try/catch
// exists to turn a failure into an envelope instead, and for project
// code's own stdout writes (that module's own header explains the split).

export interface SpawnRunWorkerOptions {
  readonly rootDir: string;
  readonly runId: string;
  /** `--env`'s raw value, or `null` when it was omitted — the same
   * unresolved-name contract src/live/spawn-daemon.ts's own `env` field
   * already uses, so run-worker-entry.ts applies the exact same
   * `resolveEnvironment` call `nuka run` itself does rather than trusting a
   * name this module resolved on the parent's behalf. */
  readonly env: string | null;
  readonly quiet: boolean;
  /** Absolute path to a temp file, one repo-relative `.feature` path per
   * line, in the order this worker should run them (src/run/worker-
   * protocol.ts's own argv contract). */
  readonly featureListPath: string;
  /** `--repeat`: how many times this worker runs its own files. */
  readonly repeat: number;
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

export function spawnRunWorker(options: SpawnRunWorkerOptions): ChildProcessByStdio<Writable, Readable, Readable> {
  const { rootDir, runId, env, quiet, featureListPath, repeat } = options;
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  const workerEntry = path.join(path.dirname(here), `run-worker-entry${ext}`);
  const args = [rootDir, runId, env ?? "", quiet ? "1" : "0", featureListPath, String(repeat)];
  const nodeArgs = ext === ".ts" ? ["--import", import.meta.resolve("tsx"), workerEntry] : [workerEntry];

  return spawn(process.execPath, [...nodeArgs, ...args], { stdio: ["pipe", "pipe", "pipe"], detached });
}
