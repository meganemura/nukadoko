import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionLockConflictError } from "./errors.js";

// Responsibility: the advisory lock file at cache/sessions/<env>/<name>.lock
// — `{ pid, started_at }` JSON. "Advisory" is deliberate: this is fs-only by
// design (no OS-level flock), so it stops nukadoko's own concurrent
// processes from colliding, not an arbitrary process bypassing it. A lock
// file whose pid is no longer alive is stale by definition (the process
// that would still care about it is gone), so it may be silently taken over
// rather than treated as a conflict.
//
// What the lock's own pid means now depends on who is holding it. A plain
// `nuka do --session <name>` acquires it in setup (before any step record
// is written) and always releases it in `finally` — the pid it writes is
// that one execution's own, alive only for as long as that single call
// runs. A live session (docs/spec.md "Live sessions") acquires it once, in
// its own daemon process (src/live/daemon.ts), and holds it for that
// process's whole life — the pid it writes is the daemon's own, and the
// lock's meaning widens from "an execution is in progress" to "this
// session is currently owned by a live process", checked the same way
// either time: `liveLockOwner` below neither knows nor cares which of the
// two it is looking at, since a live process either way is exactly what a
// stale (dead-pid) lock is not.

export interface LockInfo {
  pid: number;
  started_at: string;
}

/**
 * Whether `pid` is alive right now. ESRCH ("no such process") means it is
 * genuinely dead — the lock is stale and may be stolen. EPERM means the
 * process exists but this process lacks permission to signal it — still
 * alive, so the lock must not be stolen. Any other failure is treated the
 * same as EPERM (alive/unknown), the conservative choice for a check whose
 * only two actions are "steal" or "don't".
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Reads and parses a lock file's `{ pid, started_at }`. Returns `null` for a
 * missing, unreadable, or malformed lock file — deliberately not
 * distinguished from "no lock at all", since either way there is no
 * identifiable live owner to conflict with (a lock file this process itself
 * writes is always well-formed; malformed content can only be left over from
 * something else, e.g. manual editing).
 */
async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
  let content: string;
  try {
    content = await readFile(lockPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { pid?: unknown }).pid === "number" &&
      typeof (parsed as { started_at?: unknown }).started_at === "string"
    ) {
      return parsed as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

/** The lock's current owner, only when that owner is still alive; `null`
 * when the lock is absent, malformed, or stale (dead pid) — i.e. `null`
 * means "free to take or clear". */
export async function liveLockOwner(lockPath: string): Promise<LockInfo | null> {
  const info = await readLockInfo(lockPath);
  if (info && isProcessAlive(info.pid)) {
    return info;
  }
  return null;
}

/**
 * Acquires the lock for `sessionName`, stealing a stale (dead-pid) or
 * missing one silently. Throws `SessionLockConflictError` when another live
 * process already holds it.
 */
export async function acquireLock(lockPath: string, sessionName: string): Promise<void> {
  const owner = await liveLockOwner(lockPath);
  if (owner) {
    throw new SessionLockConflictError(sessionName, owner.pid);
  }
  // Directory 0700: same restricted-permissions rule as the session file
  // itself (docs/spec.md "The state directory"). mkdir's mode only applies
  // to directories it actually creates, so a pre-existing cache/sessions/default/
  // keeps whatever mode it already had.
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const info: LockInfo = { pid: process.pid, started_at: new Date().toISOString() };
  await writeFile(lockPath, `${JSON.stringify(info)}\n`, { mode: 0o600 });
}

/**
 * Releases a lock this process holds. A non-live `do --session` calls this
 * from its own `finally` regardless of how the run ended; a live session's
 * daemon (src/live/daemon.ts) calls it once, from its own cleanup, when the
 * session stops or its idle timeout fires. Either way a failure here (e.g.
 * the file was already removed by `session clear`) must not itself fail
 * whatever this process was already reporting, so it is swallowed rather
 * than thrown.
 */
export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await rm(lockPath, { force: true });
  } catch {
    // See doc comment above.
  }
}
