import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MalformedSessionFileError } from "./errors.js";
import type { StorageState } from "./storage-state.js";

// Responsibility: the on-disk read/write of a session's storageState JSON —
// the one place file permissions and JSON parsing for
// sessions/default/<name>.json live. Kept separate from lock.ts (a
// different file, a different failure mode: a malformed session file is a
// setup failure for `do`, a malformed lock file is silently treated as
// stale) and from manage.ts (`session list`/`clear`, which only need to
// know a file exists and when it was last written, never its parsed
// contents).

/**
 * Reads and parses a session file. Returns `null` when no file exists yet
 * (a session's first-ever use — not an error). Throws
 * `MalformedSessionFileError` for existing-but-unparseable content: unlike a
 * missing file, this is data nukadoko itself is supposed to own, so silently
 * treating it as "no session" would risk running against a stale or partial
 * cookie jar without saying so (this task's spec, decision on setup-phase
 * failures).
 */
export async function readSessionFile(
  filePath: string,
  sessionName: string,
): Promise<StorageState | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(content) as StorageState;
  } catch (error) {
    throw new MalformedSessionFileError(sessionName, error);
  }
}

/**
 * Writes `storageState` to `filePath`, creating its parent directory (0700)
 * if needed. The file itself is always left at 0600 — live credentials in
 * plaintext, per docs/spec.md "The state directory" — regardless of whether
 * it's a brand-new file or an overwrite of a previous run's: `writeFile`'s
 * own `mode` option only takes effect when the file is newly created (the
 * underlying `open()` call ignores a mode argument for a file that already
 * exists), so an explicit `chmod` afterward is the only way to guarantee
 * 0600 in both cases.
 */
export async function writeSessionFile(
  filePath: string,
  storageState: StorageState,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(storageState, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}
