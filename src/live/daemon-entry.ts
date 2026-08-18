#!/usr/bin/env node
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
// either way, the process simply ends without ever creating a socket, and
// `waitForDaemonStartup` (spawn-daemon.ts) is what turns that into a
// reported failure for whoever ran `nuka session start`.

const [rootDir, envArg, name, idleTimeoutSecondsRaw] = process.argv.slice(2);

if (rootDir === undefined || envArg === undefined || name === undefined || idleTimeoutSecondsRaw === undefined) {
  process.exit(1);
}

// `""` is the sentinel spawn-daemon.ts writes for "no --env given" — argv
// has no way to pass `null` itself.
const env = envArg === "" ? null : envArg;
const idleTimeoutMs = Number(idleTimeoutSecondsRaw) * 1000;

try {
  await runSessionDaemon({ rootDir, env, name, idleTimeoutMs });
} catch {
  process.exitCode = 1;
}
