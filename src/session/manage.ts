import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SessionLockConflictError, SessionNotFoundError } from "./errors.js";
import { liveLockOwner } from "./lock.js";
import { sessionFilePath, sessionLockPath, sessionsDir } from "./paths.js";

// Responsibility: `nuka session list`/`clear`'s actual work (this task's
// spec, item 4) — enumerate and delete session files under
// sessions/default/ — kept out of cli/session.ts so it's unit-testable
// without going through yargs (same split as cli/do.ts vs cli/run-cli.ts).
// A session's existence is defined by its .json file; a .lock file with no
// matching .json (a session whose first-ever `do` run never got as far as
// opening a browser/request context) is not itself a "session" `list`
// reports, but it still guards `clear` below.

export interface SessionInfo {
  environment: "default";
  name: string;
  /** ISO 8601, the session file's own mtime. */
  updated_at: string;
}

const JSON_SUFFIX = ".json";
const LOCK_SUFFIX = ".lock";

export async function listSessions(rootDir: string, stateDir: string): Promise<SessionInfo[]> {
  const dir = sessionsDir(rootDir, stateDir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // No sessions directory yet is a valid, if unhelpful, answer: an empty
    // list, not an error (this task's spec: "0 件でも exit 0").
    return [];
  }

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(JSON_SUFFIX))
    .map((entry) => entry.name.slice(0, -JSON_SUFFIX.length))
    .sort();

  const infos: SessionInfo[] = [];
  for (const name of names) {
    const stats = await stat(path.join(dir, `${name}${JSON_SUFFIX}`));
    infos.push({ environment: "default", name, updated_at: stats.mtime.toISOString() });
  }
  return infos;
}

/**
 * Deletes one session's file and its lock file (stale lock only — a live
 * one refuses the whole operation, per this task's spec). Throws
 * `SessionNotFoundError` when no session file exists under `name`, and
 * `SessionLockConflictError` when a live process still holds its lock.
 */
export async function clearSession(rootDir: string, stateDir: string, name: string): Promise<void> {
  const jsonPath = sessionFilePath(rootDir, stateDir, name);
  const lockPath = sessionLockPath(rootDir, stateDir, name);

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
 * Deletes every session (and lock) file under the default environment.
 * All-or-nothing: if even one lock is live, nothing is deleted (this task's
 * spec: "部分削除はしない") and `SessionLockConflictError` is thrown naming
 * that session. A lock file with no matching session file still counts —
 * it represents a `do` run that is (or claims to be) in progress.
 */
export async function clearAllSessions(rootDir: string, stateDir: string): Promise<void> {
  const dir = sessionsDir(rootDir, stateDir);
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
