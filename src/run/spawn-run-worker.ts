import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

// Responsibility: turns "run run-worker-entry.ts against this argument
// list" into an actual child process, attached (never `detached`, unlike
// src/live/spawn-daemon.ts's own session daemon: `nuka run --concurrency
// <n>` waits for every worker to finish before it can print its own
// summary and exit, so the parent must keep each worker as a real child it
// can await, not one it hands off and forgets).
//
// The interpreter choice mirrors src/live/spawn-daemon.ts's own
// `spawnDaemon` exactly, for the same reason: run-worker-entry.ts's own
// file extension, read off *this* module's own `import.meta.url`, is `.ts`
// in this repository's own dev/test run and `.js` once tsconfig.build.json
// has mirrored `src/` onto `dist/` — tsx (nukadoko's own direct dependency)
// is what makes the `.ts` case runnable at all outside a build.
//
// `stdio: ["ignore", "pipe", "pipe"]`: stdin is unused, stdout carries this
// worker's own envelope stream (src/run/worker-protocol.ts), stderr is kept
// only for whatever Node itself writes there before this worker's own
// try/catch exists to turn a failure into an envelope instead (that
// module's own header explains the split).

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

function packageRoot(here: string): string {
  return path.resolve(path.dirname(here), "..", "..");
}

export function spawnRunWorker(options: SpawnRunWorkerOptions): ChildProcessByStdio<null, Readable, Readable> {
  const { rootDir, runId, env, quiet, featureListPath, repeat } = options;
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here);
  const workerEntry = path.join(path.dirname(here), `run-worker-entry${ext}`);
  const args = [rootDir, runId, env ?? "", quiet ? "1" : "0", featureListPath, String(repeat)];

  return ext === ".ts"
    ? spawn(path.join(packageRoot(here), "node_modules", ".bin", "tsx"), [workerEntry, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn(process.execPath, [workerEntry, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
}
