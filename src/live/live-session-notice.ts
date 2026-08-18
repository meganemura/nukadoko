import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { DEFAULT_ENVIRONMENT_NAME } from "../environment/resolve-environment.js";
import { liveLockOwner } from "../session/lock.js";
import { sessionLockPath, sessionSockPath, sessionsDir, sessionsRootDir } from "../session/paths.js";

// Responsibility: tell `nuka run`/`nuka accept` about a live session that is
// still open when they start (docs/spec.md "Live sessions"), without acting
// on it. A live session's `ctx` stays open across many `nuka do --session`
// calls on purpose, so the app it points at can carry state one execution
// left for the next to build on. A `run`/`accept` starting up right now has
// no way to know whether that state matters to it, so this only reports
// what is open and how to stop it. The judgment stays with whoever reads
// stderr, the same "fact, not verdict" rule `nuka tend`'s `from-unused`
// finding already follows.
//
// Detection reuses exactly what a live session already is, nothing new:
// `liveLockOwner` (a lock whose own pid is still alive) plus its socket
// actually existing. The socket is the second check because a live lock
// alone is not proof of a live *session* specifically — a plain, non-live
// `nuka do --session <name>` holds the very same kind of lock for the
// length of one call (session/lock.ts's own header), and only a session's
// daemon ever opens a socket beside it.
//
// Every environment is walked, not just the one this invocation targets:
// the app a session was opened against is shared across environments, so a
// live session under a different environment can still be the one holding
// state this run's own environment would otherwise look untouched by.
//
// Read-only, unlike `session list` (src/session/manage.ts): a stale lock
// found here is left alone rather than reaped, since reaping is that other
// command's job, not a side effect `run`/`accept` should carry.

const LOCK_SUFFIX = ".lock";

export interface LiveSessionRef {
  readonly environment: string;
  readonly name: string;
}

/**
 * Every currently-live session across every environment under
 * `<stateDir>/cache/sessions/`. An empty list is the ordinary case (no
 * sessions directory yet, or every lock there is stale) and is not an
 * error.
 */
export async function findLiveSessions(rootDir: string, stateDir: string): Promise<LiveSessionRef[]> {
  const root = sessionsRootDir(rootDir, stateDir);
  let rootEntries;
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const environments = rootEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const found: LiveSessionRef[] = [];
  for (const environment of environments) {
    const dir = sessionsDir(rootDir, stateDir, environment);
    let dirEntries;
    try {
      dirEntries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = dirEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith(LOCK_SUFFIX))
      .map((entry) => entry.name.slice(0, -LOCK_SUFFIX.length))
      .sort();

    for (const name of names) {
      const lockPath = sessionLockPath(rootDir, stateDir, environment, name);
      const owner = await liveLockOwner(lockPath);
      if (owner === null) continue;
      if (!existsSync(sessionSockPath(rootDir, stateDir, environment, name))) continue;
      found.push({ environment, name });
    }
  }
  return found;
}

/**
 * One line per live session, naming it, its environment, and how to stop
 * it. `null` when `sessions` is empty, so a caller can `if` on the result
 * instead of writing a blank line to stderr on the common, no-session path.
 * `--env` is only added to the stop command for a non-default environment,
 * matching `nuka session stop`'s own default (src/cli/session.ts).
 */
export function formatLiveSessionNotice(sessions: readonly LiveSessionRef[]): string | null {
  if (sessions.length === 0) return null;
  return sessions
    .map((session) => {
      const envFlag =
        session.environment === DEFAULT_ENVIRONMENT_NAME ? "" : ` --env ${session.environment}`;
      return (
        `Live session "${session.name}" (environment ${session.environment}) is still open. ` +
        "The app it points at may hold state that earlier exploring left behind. " +
        `Stop it with \`nuka session stop ${session.name}${envFlag}\`.`
      );
    })
    .join("\n");
}
