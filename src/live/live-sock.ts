import { rm, rmdir } from "node:fs/promises";
import path from "node:path";

// Responsibility: the shape of a live session's own socket path (docs/
// spec.md "Live sessions") — the two literals `live/daemon.ts`'s own
// mkdtemp call and `cli/session.ts`'s own preflight length check both need
// to agree on, and the one function that safely removes a stale one once a
// caller already knows it from a lock file (session/lock.ts's own `sock`
// field) rather than deriving it.
//
// The socket lives under the OS's own temp directory, never under this
// project's `stateDir`: a project's own path can be arbitrarily deep (a
// worktree, a monorepo package, a nested checkout), and `os.tmpdir()` does
// not grow with it, which is the entire reason this file exists — see
// `live/daemon.ts`'s own header for the failure this replaces. The
// directory mkdtemp creates is what keeps the socket unguessable (its
// six-character suffix, not the session name), the same property a stolen
// storageState file would need to be protected against too.

/** Passed to `mkdtemp(path.join(os.tmpdir(), ...))` — mkdtemp appends
 * exactly six random characters directly after this prefix, never a
 * separate "XXXXXX" placeholder, so a caller predicting the resulting
 * path's own byte length (`cli/session.ts`'s own preflight check) can
 * stand in any six ASCII characters for that suffix and get the same
 * length back. */
export const LIVE_SOCK_DIR_PREFIX = "nuka-live-";

/** The socket file's own name inside the directory mkdtemp creates. */
export const LIVE_SOCK_FILE_NAME = "live.sock";

/**
 * Removes a stale live session's socket file and the mkdtemp'd directory
 * that held it, given `sockPath` already read out of a lock file (session/
 * lock.ts's own `sock` field) by a caller that has already decided the
 * session behind it is not live. Non-recursive on purpose (`rmdir`, not a
 * recursive `rm`): `sockPath`'s own directory came from JSON on disk, and a
 * directory that turns out not to be empty — a corrupted lock, or a future
 * version's mkdtemp shape no longer matching this one — fails this call
 * instead of deleting whatever else actually turns out to be in it.
 * Best-effort throughout: every caller already treats a missing or
 * already-gone directory as nothing worth reporting, the same posture every
 * other stale-debris cleanup in this package already takes.
 */
export async function removeLiveSockDir(sockPath: string): Promise<void> {
  await rm(sockPath, { force: true }).catch(() => {});
  await rmdir(path.dirname(sockPath)).catch(() => {});
}
