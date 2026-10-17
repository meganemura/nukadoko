import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/load-config.js";
import { validateEnvironmentName } from "../environment/name.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import { sendLiveRequest } from "../live/client.js";
import { LIVE_SOCK_DIR_PREFIX, LIVE_SOCK_FILE_NAME, removeLiveSockDir } from "../session/live-sock.js";
import { checkSockPathLength, spawnDaemon, waitForDaemonStartup } from "../live/spawn-daemon.js";
import { clearAllSessions, clearSession, listSessions } from "../session/manage.js";
import { liveLockOwner, readLockInfo } from "../session/lock.js";
import { validateSessionName } from "../session/name.js";
import { sessionCrashLogPath, sessionFilePath, sessionLockPath, sessionsDir } from "../session/paths.js";
import { MAX_IDLE_TIMEOUT_SECONDS } from "./option-defaults.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: `nuka session list`/`clear`/`start`/`stop`'s CLI-facing
// wiring, kept out of run-cli.ts so it's unit-testable without going
// through yargs (same split as cli/do.ts vs cli/run-cli.ts). `list`/`clear`
// only ever touch files nukadoko itself already owned before live sessions
// existed; `start`/`stop` are this feature's own two verbs (docs/spec.md
// "Live sessions") and are the only two commands here that ever talk to a
// live process rather than only its files.
//
// `start`'s own bounded wait for the daemon to come up (`waitForDaemonStartup`,
// src/live/spawn-daemon.ts) is what keeps this command from ever printing
// success for a session that in fact never started — the daemon's own
// `stdio: "ignore"` (spawn-daemon.ts's own header) means this is the only
// place that failure can surface at all.
//
// `stop` reaches a live session over its own socket (never by deleting its
// files out from under it): only the daemon itself can write this
// session's ending storageState to the same cache/sessions/<env>/<name>.json
// a session has always left behind (docs/spec.md "Live sessions"), so
// stopping has to ask it to, not merely tear its files down. A session with
// no live owner has nothing to ask: `stop` cleans up any debris and exits
// 0. When that name also left no session file and no lock, stderr names
// the session and the environment. A typo must not look like the real
// session stopped, because that process keeps its browser until the idle
// timeout.

export interface RunSessionListOptions {
  rootDir: string;
  json: boolean;
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runSessionList(options: RunSessionListOptions): Promise<number> {
  const { rootDir, json, stdout, stderr } = options;

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  const sessions = await listSessions(rootDir, config.stateDir);

  if (json) {
    stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
  } else {
    for (const session of sessions) {
      stdout.write(`${session.name}\t${session.updated_at}\t${session.alive ? "alive" : "stopped"}\n`);
    }
  }
  // Empty is a valid, if unhelpful, answer, so exit 0 even with zero
  // results, never an error.
  return 0;
}

export interface RunSessionClearOptions {
  rootDir: string;
  /** `null` clears every session for the environment. */
  name: string | null;
  /** `--env`'s raw value, or `null` when omitted. Omitted resolves to the
   * implicit "default" environment, which does not have to be listed in
   * the config. There is no all-environments clear. */
  env: string | null;
  stdout: WritableSink;
  stderr: WritableSink;
}

/** A session file or a lock is something `clear` can still delete. A crash
 * log is not: it is a start failure's note, not a session. */
async function environmentHasSessionFiles(
  rootDir: string,
  stateDir: string,
  environment: string,
): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir(rootDir, stateDir, environment));
  } catch {
    return false;
  }
  return entries.some((entry) => entry.endsWith(".json") || entry.endsWith(".lock"));
}

export async function runSessionClear(options: RunSessionClearOptions): Promise<number> {
  const { rootDir, name, env, stderr } = options;
  const environment = env ?? DEFAULT_ENVIRONMENT_NAME;

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  try {
    validateEnvironmentName(environment);
    // An explicit `--env` the config does not define is the same mistake
    // `session stop --env` already refuses. The exception is files still
    // sitting under that name: the environment may have been removed from
    // the config, and clear is how those files go. Nothing left to delete
    // has no such reason, so that one is the refusal.
    if (env !== null) {
      let unknown: unknown;
      try {
        resolveEnvironment(config, environment, true);
      } catch (error) {
        unknown = error;
      }
      if (unknown !== undefined) {
        if (await environmentHasSessionFiles(rootDir, config.stateDir, environment)) {
          stderr.write(
            `Environment "${environment}" is not defined in nukadoko.config.ts's "environments"; clearing the sessions left under it\n`,
          );
        } else {
          throw unknown;
        }
      }
    }
    if (name === null) {
      await clearAllSessions(rootDir, config.stateDir, environment);
    } else {
      validateSessionName(name);
      await clearSession(rootDir, config.stateDir, environment, name);
    }
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // Silent on success for a known environment, like `rm`: stdout is
  // reserved for `do`'s step record and `list`'s listing. The one stderr
  // line above is the unknown-environment case, written before this return.
  return 0;
}

export interface RunSessionStartOptions {
  rootDir: string;
  name: string;
  /** `--env`'s raw value, or `null` when omitted — resolved the same way
   * `nuka do`'s own setup phase resolves it (do.ts). */
  env: string | null;
  idleTimeoutSeconds: number;
  stdout: WritableSink;
  stderr: WritableSink;
}

/** Bounded wait for the daemon to either open its socket or fail —
 * generous enough to cover discovery walking a real project's step files,
 * short enough that a hung daemon does not leave `nuka session start`
 * itself hanging indefinitely. */
const STARTUP_TIMEOUT_MS = 15_000;


export { MAX_IDLE_TIMEOUT_SECONDS };

/** Refusal for `--idle-timeout`, or null when `seconds` is finite, greater
 * than 0, and at most `MAX_IDLE_TIMEOUT_SECONDS`. yargs' `type: "number"`
 * turns an unparseable flag into NaN and accepts 0, a negative, and a
 * value past that limit, so this is the check, not the flag parser. */
export function idleTimeoutRefusal(seconds: number): string | null {
  if (Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_IDLE_TIMEOUT_SECONDS) {
    return null;
  }
  return (
    "--idle-timeout must be a finite number of seconds greater than 0 and at most " +
    `${MAX_IDLE_TIMEOUT_SECONDS} (got ${seconds}).\n`
  );
}

export async function runSessionStart(options: RunSessionStartOptions): Promise<number> {
  const { rootDir, name, env, idleTimeoutSeconds, stdout, stderr } = options;

  // Before config load and before spawn. A delay Node clamps to 1 ms would
  // start a daemon that stops itself the moment it listens, and the only
  // report left would be that the process exited before it was ready,
  // naming neither this flag nor the limit.
  const refusal = idleTimeoutRefusal(idleTimeoutSeconds);
  if (refusal !== null) {
    stderr.write(refusal);
    return 1;
  }

  try {
    validateSessionName(name);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  let resolvedEnv: ResolvedEnvironment;
  try {
    resolvedEnv = resolveEnvironment(config, env ?? DEFAULT_ENVIRONMENT_NAME, env !== null);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const lockPath = sessionLockPath(rootDir, config.stateDir, resolvedEnv.name, name);
  const crashLogPath = sessionCrashLogPath(rootDir, config.stateDir, resolvedEnv.name, name);

  // A fast, best-effort refusal before ever spawning anything — the
  // daemon's own `acquireLock` (src/live/daemon.ts) is the authoritative
  // check that actually wins or loses a race against another `session
  // start` of the same name; this one only avoids spawning a child doomed
  // to lose it.
  const owner = await liveLockOwner(lockPath);
  if (owner !== null) {
    stderr.write(
      `Session "${name}" already has a live process (pid ${owner.pid}); stop it first with ` +
        `\`nuka session stop ${name}\`\n`,
    );
    return 1;
  }

  // Refused here, loudly, before anything spawns. The socket no longer
  // lives under this project at all (live-sock.ts's own header), so a deep
  // project path cannot push it over this platform's own unix domain
  // socket path limit any more — only a long `os.tmpdir()` still can, on
  // some platform this measurement has not seen. Predicted rather than
  // read back from the daemon, since that child has no terminal to report
  // `EINVAL` to once it is running (spawn-daemon.ts's own header): mkdtemp
  // appends exactly six characters after `LIVE_SOCK_DIR_PREFIX`
  // (live-sock.ts's own doc comment), so any six-character stand-in
  // predicts the real path's own byte length exactly, without knowing
  // which six characters mkdtemp will actually choose.
  const predictedSockPath = path.join(os.tmpdir(), `${LIVE_SOCK_DIR_PREFIX}XXXXXX`, LIVE_SOCK_FILE_NAME);
  const lengthCheck = checkSockPathLength(predictedSockPath);
  if (!lengthCheck.ok) {
    stderr.write(
      `Session "${name}" cannot start: its own live-session socket path is ${lengthCheck.byteLength} bytes, over ` +
        `this platform's ${lengthCheck.limit}-byte limit on a socket path.\n` +
        `Path (mkdtemp fills XXXXXX in with 6 random characters): ${predictedSockPath}\n` +
        "This is the OS's own temp directory, not this project's; a shorter TMPDIR is the only way around it.\n",
    );
    return 1;
  }

  // A stale lock naming a socket from a daemon that crashed without
  // cleaning up after itself would otherwise leak that daemon's own
  // mkdtemp'd directory forever: nothing else ever visits a session name
  // once its lock is gone. Reaped here, before a fresh daemon starts under
  // the same name, the same "clear debris before it can be blamed on the
  // wrong attempt" reasoning already applies to the crash log just below.
  const staleInfo = await readLockInfo(lockPath);
  if (staleInfo?.sock !== undefined) {
    await removeLiveSockDir(staleInfo.sock);
  }
  await rm(crashLogPath, { force: true }).catch(() => {});

  const child = spawnDaemon({ rootDir, env, name, idleTimeoutSeconds, crashLogPath });
  const outcome = await waitForDaemonStartup(child, lockPath, STARTUP_TIMEOUT_MS);
  if (!outcome.ok) {
    // The daemon's own child writes this file only when it dies from a
    // thrown, unnamed setup failure (daemon-entry.ts's own header) — named
    // here, when it exists, so a failure that outcome.message alone cannot
    // explain (e.g. "exited before it was ready", the same shape an
    // unmeasured EINVAL would produce) still has somewhere to point a user.
    const crashLogNote = existsSync(crashLogPath) ? `Its own crash log may explain why: ${crashLogPath}\n` : "";
    stderr.write(`Failed to start session "${name}": ${outcome.message}\n${crashLogNote}`);
    return 1;
  }

  // Read back from the lock rather than `child.pid`: the lock is what every
  // other command in this package signals a session by, and by the time
  // the socket exists (just confirmed above) the daemon has written it.
  const daemonOwner = await liveLockOwner(lockPath);
  stdout.write(`${name}\t${daemonOwner?.pid ?? child.pid}\n`);
  return 0;
}

export interface RunSessionStopOptions {
  rootDir: string;
  name: string;
  env: string | null;
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runSessionStop(options: RunSessionStopOptions): Promise<number> {
  const { rootDir, name, env, stderr } = options;

  try {
    validateSessionName(name);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  let resolvedEnv: ResolvedEnvironment;
  try {
    resolvedEnv = resolveEnvironment(config, env ?? DEFAULT_ENVIRONMENT_NAME, env !== null);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const lockPath = sessionLockPath(rootDir, config.stateDir, resolvedEnv.name, name);

  const owner = await liveLockOwner(lockPath);
  if (owner === null) {
    // Nothing alive to ask. Clean up whatever debris (a dead lock, and its
    // socket's own mkdtemp'd directory if the lock still names one) is left
    // and exit 0: stopping a session that is already gone is idempotent.
    // A name that left neither a session file nor a lock was never a
    // session. Say so. Otherwise a typo looks like the real session
    // stopped, and that process keeps its browser until the idle timeout.
    const sessionPath = sessionFilePath(rootDir, config.stateDir, resolvedEnv.name, name);
    const existed = existsSync(lockPath) || existsSync(sessionPath);
    const staleInfo = await readLockInfo(lockPath);
    if (staleInfo?.sock !== undefined) {
      await removeLiveSockDir(staleInfo.sock);
    }
    await rm(lockPath, { force: true }).catch(() => {});
    if (!existed) {
      stderr.write(`no session "${name}" in environment "${resolvedEnv.name}"\n`);
    }
    return 0;
  }

  if (owner.sock === undefined) {
    // An alive lock naming no socket is not a live session's own daemon:
    // `acquireLock` (session/lock.ts) always writes `sock` together with
    // `pid`/`started_at`, in the one call a live session ever makes, so a
    // lock without it is a plain `nuka do --session` execution still in
    // flight, holding this same kind of lock for the length of one call
    // (session/lock.ts's own header). There is nothing to dial, and that
    // execution owns the lock legitimately, so nothing here is touched.
    stderr.write(
      `Failed to stop session "${name}" (pid ${owner.pid}): no live session socket is recorded for this lock; ` +
        "it may be a plain `nuka do --session` execution still in progress rather than a live session\n",
    );
    return 1;
  }

  const outcome = await sendLiveRequest(owner.sock, { kind: "stop" });
  if (!outcome.ok) {
    const message =
      outcome.kind === "reply" ? `unrecognized reply: ${outcome.message}` : outcome.message;
    stderr.write(`Failed to stop session "${name}" (pid ${owner.pid}): ${message}\n`);
    return 1;
  }
  if (outcome.response.status === "rejected") {
    stderr.write(`Session "${name}" did not stop: ${outcome.response.message}\n`);
    return 1;
  }
  // Exit stays 0, as for `nuka do` and `nuka run`: a failed teardown is
  // announced, never a failed command.
  for (const warning of outcome.response.warnings ?? []) {
    stderr.write(`${warning}\n`);
  }

  return 0;
}
