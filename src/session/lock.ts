import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionLockConflictError } from "./errors.js";

// Responsibility: the advisory lock file at sessions/default/<name>.lock —
// `{ pid, started_at }` JSON, checked/acquired in `do`'s setup phase (before
// any receipt is written) and always released in its `finally` (this task's
// spec, decision 4). "Advisory" is deliberate: this is fs-only (no daemon,
// no OS-level flock — the task's own constraint), so it stops nukadoko's own
// concurrent `do`/`session clear` calls from colliding, not an arbitrary
// process bypassing it. A lock file whose pid is no longer alive is stale by
// definition (the process that would still care about it is gone), so it
// may be silently taken over rather than treated as a conflict.

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
  // to directories it actually creates, so a pre-existing sessions/default/
  // keeps whatever mode it already had.
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const info: LockInfo = { pid: process.pid, started_at: new Date().toISOString() };
  await writeFile(lockPath, `${JSON.stringify(info)}\n`, { mode: 0o600 });
}

/**
 * Releases a lock this process holds. Always called from `do`'s `finally`
 * regardless of how the run ended (this task's spec, decision 4); a failure
 * here (e.g. the file was already removed by `session clear`) must not
 * itself fail the run whose receipt (or setup error) is already decided, so
 * it is swallowed rather than thrown.
 */
export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await rm(lockPath, { force: true });
  } catch {
    // See doc comment above.
  }
}
