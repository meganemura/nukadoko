import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { removeLiveSockDir } from "../live/live-sock.js";
import { SessionLockConflictError, SessionNotFoundError } from "./errors.js";
import { liveLockOwner, readLockInfo } from "./lock.js";
import { sessionFilePath, sessionLockPath, sessionsDir, sessionsRootDir } from "./paths.js";

// Responsibility: `nuka session list`/`clear`'s actual work — enumerate and
// delete session files under cache/sessions/<env>/ —
// kept out of cli/session.ts so it's unit-testable without going through
// yargs (same split as cli/do.ts vs cli/run-cli.ts). `listSessions` walks
// every environment's subdirectory; `clearSession`/
// `clearAllSessions` are scoped to one environment at a time — there is no
// all-environments clear, on purpose (accidental-deletion risk with no real
// use case).
//
// A session's existence used to be defined by its .json file alone; a live
// session (docs/spec.md "Live sessions") widens that, since a session that
// has never been stopped has no .json yet — its storageState is only
// written at `stop` — but is very much a session `list` should report,
// alive, the moment `start` returns. `listSessions` below therefore reports
// the union of every name with a .json *or* a live lock, and reaps a lock
// (and its socket) whose own pid is dead exactly the way it always reaped
// nothing at all for that case: a dead lock with no .json was debris before
// this feature existed and still is, never itself a "session" worth
// reporting — only a *live* lock earns a listing when there is no .json
// behind it yet.

export interface SessionInfo {
  environment: string;
  name: string;
  /** ISO 8601 — the session file's own mtime when one exists, or the live
   * lock's own `started_at` for a session that has never been stopped
   * (hence has no .json yet). */
  updated_at: string;
  /** Whether this name's own lock is currently held by a live process
   * (docs/spec.md "Live sessions") — `false` for an ordinary, not-live
   * session (every session before this feature existed, and any session
   * between `stop`s), never an error condition on its own. */
  alive: boolean;
}

const JSON_SUFFIX = ".json";
const LOCK_SUFFIX = ".lock";

async function entryNames(dir: string, suffix: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name.slice(0, -suffix.length));
}

/**
 * Lists every session across every environment (there is no per-environment
 * filter here — `session list` always reports everything, unlike `clear`).
 * No sessions directory yet is a valid, if unhelpful, answer: an empty list,
 * not an error. Also reaps: any name whose lock's own pid is no longer
 * alive has its lock and socket removed before this returns (its .json, if
 * any, is left untouched — that is saved state, not debris).
 */
export async function listSessions(rootDir: string, stateDir: string): Promise<SessionInfo[]> {
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

  const infos: SessionInfo[] = [];
  for (const environment of environments) {
    const dir = sessionsDir(rootDir, stateDir, environment);
    const jsonNames = await entryNames(dir, JSON_SUFFIX);
    const lockNames = await entryNames(dir, LOCK_SUFFIX);
    const names = [...new Set([...jsonNames, ...lockNames])].sort();

    for (const name of names) {
      const lockPath = sessionLockPath(rootDir, stateDir, environment, name);
      const owner = await liveLockOwner(lockPath);
      const hasJson = jsonNames.includes(name);

      if (owner === null && lockNames.includes(name)) {
        // A dead pid's lock is stale by definition (lock.ts's own header) —
        // its socket (if any) is exactly as stale, since nothing is
        // listening behind it any more. The socket's own path only ever
        // lived in this lock file's own `sock` field (it moved out of
        // `stateDir` entirely, so nothing else can derive it) — read here,
        // before the lock itself is removed, or it is lost for good.
        const staleInfo = await readLockInfo(lockPath);
        await rm(lockPath, { force: true });
        if (staleInfo?.sock !== undefined) {
          await removeLiveSockDir(staleInfo.sock);
        }
      }

      let updatedAt: string;
      if (hasJson) {
        const stats = await stat(sessionFilePath(rootDir, stateDir, environment, name));
        updatedAt = stats.mtime.toISOString();
      } else if (owner !== null) {
        updatedAt = owner.started_at;
      } else {
        // A dead, .json-less lock just reaped above: nothing left to
        // report for this name, the same "not itself a session" rule this
        // file's own header always applied to that case.
        continue;
      }
      infos.push({ environment, name, updated_at: updatedAt, alive: owner !== null });
    }
  }
  return infos;
}

/**
 * Deletes one session's file and its lock file (stale lock only — a live
 * one refuses the whole operation). Throws
 * `SessionNotFoundError` when no session file exists under `name` in
 * `environment`, and `SessionLockConflictError` when a live process still
 * holds its lock.
 */
export async function clearSession(
  rootDir: string,
  stateDir: string,
  environment: string,
  name: string,
): Promise<void> {
  const jsonPath = sessionFilePath(rootDir, stateDir, environment, name);
  const lockPath = sessionLockPath(rootDir, stateDir, environment, name);

  if (!existsSync(jsonPath)) {
    throw new SessionNotFoundError(name);
  }
  const owner = await liveLockOwner(lockPath);
  if (owner) {
    throw new SessionLockConflictError(name, owner.pid);
  }

  await rm(jsonPath, { force: true });
  await rm(lockPath, { force: true });
}

/**
 * Deletes every session (and lock) file under one environment. All-or-
 * nothing: if even one lock is live, nothing is deleted (no partial
 * deletion) and `SessionLockConflictError` is thrown naming that
 * session. A lock file with no matching session file still counts — it
 * represents a `do` run that is (or claims to be) in progress. Scoped to
 * `environment` only: clearing every environment at once is deliberately not
 * offered.
 */
export async function clearAllSessions(
  rootDir: string,
  stateDir: string,
  environment: string,
): Promise<void> {
  const dir = sessionsDir(rootDir, stateDir, environment);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const lockEntries = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(LOCK_SUFFIX),
  );
  for (const entry of lockEntries) {
    const lockPath = path.join(dir, entry.name);
    const owner = await liveLockOwner(lockPath);
    if (owner) {
      throw new SessionLockConflictError(entry.name.slice(0, -LOCK_SUFFIX.length), owner.pid);
    }
  }

  const removable = entries.filter(
    (entry) => entry.isFile() && (entry.name.endsWith(JSON_SUFFIX) || entry.name.endsWith(LOCK_SUFFIX)),
  );
  for (const entry of removable) {
    await rm(path.join(dir, entry.name), { force: true });
  }
}
