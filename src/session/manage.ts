import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SessionLockConflictError, SessionNotFoundError } from "./errors.js";
import { liveLockOwner } from "./lock.js";
import { sessionFilePath, sessionLockPath, sessionsDir, sessionsRootDir } from "./paths.js";

// Responsibility: `nuka session list`/`clear`'s actual work (this task's
// spec, item 4) — enumerate and delete session files under sessions/<env>/ —
// kept out of cli/session.ts so it's unit-testable without going through
// yargs (same split as cli/do.ts vs cli/run-cli.ts). `listSessions` walks
// every environment's subdirectory (m1-environments task spec, decision 7:
// list enumerates by scanning every environment's subdirectory);
// `clearSession`/
// `clearAllSessions` are scoped to one environment at a time — there is no
// all-environments clear, on purpose (accidental-deletion risk with no real
// use case). A session's existence is defined by its .json file; a .lock
// file with no matching .json (a session whose first-ever `do` run never got
// as far as opening a browser/request context) is not itself a "session"
// `list` reports, but it still guards `clear` below.

export interface SessionInfo {
  environment: string;
  name: string;
  /** ISO 8601, the session file's own mtime. */
  updated_at: string;
}

const JSON_SUFFIX = ".json";
const LOCK_SUFFIX = ".lock";

async function listSessionNames(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(JSON_SUFFIX))
    .map((entry) => entry.name.slice(0, -JSON_SUFFIX.length))
    .sort();
}

/**
 * Lists every session across every environment (there is no per-environment
 * filter here — `session list` always reports everything, unlike `clear`).
 * No sessions directory yet is a valid, if unhelpful, answer: an empty list,
 * not an error.
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
    for (const name of await listSessionNames(dir)) {
      const stats = await stat(path.join(dir, `${name}${JSON_SUFFIX}`));
      infos.push({ environment, name, updated_at: stats.mtime.toISOString() });
    }
  }
  return infos;
}

/**
 * Deletes one session's file and its lock file (stale lock only — a live
 * one refuses the whole operation, per this task's spec). Throws
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
 * nothing: if even one lock is live, nothing is deleted (this task's spec:
 * no partial deletion) and `SessionLockConflictError` is thrown naming that
 * session. A lock file with no matching session file still counts — it
 * represents a `do` run that is (or claims to be) in progress. Scoped to
 * `environment` only: clearing every environment at once is deliberately not
 * offered (m1-environments task spec, decision 7).
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
