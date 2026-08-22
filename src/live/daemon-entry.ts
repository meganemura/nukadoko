#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runSessionDaemon } from "./daemon.js";

// Responsibility: the process entry point for one live session's own
// detached child (docs/spec.md "Live sessions") — spawned by spawn-
// daemon.ts's own `spawnDaemon`, never invoked directly by a user and never
// listed in `nuka --help` (the same "entry point owns only argv/exit-code
// plumbing" split src/cli.ts already follows for the main CLI, applied here
// to a private, positional argv contract instead of yargs).
//
// stdio is `"ignore"` for this whole process (spawn-daemon.ts) — there is
// no terminal on the other end of stdout/stderr, so a setup failure here
// has nowhere to be printed. `runSessionDaemon` itself already exits
// cleanly (via `process.exitCode`) for the failures it can name; this
// file's own `catch` is the last-resort backstop for anything it can't —
// a thrown, unnamed setup failure (e.g. `listen()` rejecting with `EINVAL`
// for a socket path spawn-daemon.ts's own `checkSockPathLength` could not
// rule out ahead of time on some platform this package has not measured).
// Either way the process simply ends without ever creating a socket, and
// `waitForDaemonStartup` (spawn-daemon.ts) is what turns that into a
// reported failure for whoever ran `nuka session start` — but that report
// can only ever be "it failed", never *why*, unless the reason is written
// somewhere this process's own stdio being `"ignore"` does not block: the
// crash log this file's own `catch` writes below, at the path `nuka
// session start` already computed and passed as this process's own fifth
// argument.

const [rootDir, envArg, name, idleTimeoutSecondsRaw, crashLogPath] = process.argv.slice(2);

if (
  rootDir === undefined ||
  envArg === undefined ||
  name === undefined ||
  idleTimeoutSecondsRaw === undefined ||
  crashLogPath === undefined
) {
  process.exit(1);
}

// `""` is the sentinel spawn-daemon.ts writes for "no --env given" — argv
// has no way to pass `null` itself.
const env = envArg === "" ? null : envArg;
const idleTimeoutMs = Number(idleTimeoutSecondsRaw) * 1000;

try {
  await runSessionDaemon({ rootDir, env, name, idleTimeoutMs });
} catch (error) {
  process.exitCode = 1;
  try {
    // Same 0600 reasoning as a session's own storageState file
    // (src/session/store.ts's own `writeSessionFile`): a thrown setup
    // error can carry a path or a config value from this project, so the
    // crash log gets the same restricted permissions every other file
    // beside it in cache/sessions/<env>/ already does.
    await mkdir(path.dirname(crashLogPath), { recursive: true, mode: 0o700 });
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    await writeFile(crashLogPath, `${new Date().toISOString()} ${detail}\n`, { mode: 0o600 });
    await chmod(crashLogPath, 0o600);
  } catch {
    // Best effort: a crash log write failing must not mask the real
    // failure by throwing a second, unrelated one out of this catch — the
    // process still ends non-zero either way (`process.exitCode` above),
    // which is what `waitForDaemonStartup` actually depends on.
  }
}
