import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { loadConfig } from "../config/load-config.js";
import { validateEnvironmentName } from "../environment/name.js";
import {
  DEFAULT_ENVIRONMENT_NAME,
  resolveEnvironment,
  type ResolvedEnvironment,
} from "../environment/resolve-environment.js";
import { sendLiveRequest } from "../live/client.js";
import { checkSockPathLength, spawnDaemon, waitForDaemonStartup } from "../live/spawn-daemon.js";
import { clearAllSessions, clearSession, listSessions } from "../session/manage.js";
import { liveLockOwner } from "../session/lock.js";
import { validateSessionName } from "../session/name.js";
import { sessionCrashLogPath, sessionLockPath, sessionSockPath } from "../session/paths.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

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
// no live owner has nothing to ask — `stop` cleans up any debris and
// succeeds quietly, the same "clear is silent on success" convention
// `runSessionClear` below already follows.

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
  /** `null` clears every session for `environment`. */
  name: string | null;
  /** `--env`'s value; "default" when omitted (there is no all-environments
   * clear). */
  environment: string;
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runSessionClear(options: RunSessionClearOptions): Promise<number> {
  const { rootDir, name, environment, stderr } = options;

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  try {
    validateEnvironmentName(environment);
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

  // Silent on success, like `rm`: stdout is reserved for `do`'s step record
  // and `list`'s listing; a successful `clear` has nothing structured to
  // report.
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

export async function runSessionStart(options: RunSessionStartOptions): Promise<number> {
  const { rootDir, name, env, idleTimeoutSeconds, stdout, stderr } = options;

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
  const sockPath = sessionSockPath(rootDir, config.stateDir, resolvedEnv.name, name);
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

  // Refused here, loudly, before anything spawns: a monorepo or a deeply
  // nested checkout can put `sockPath` past this platform's own unix
  // domain socket path limit, and the daemon's own child has no terminal
  // to report that failure to once it is running (spawn-daemon.ts's own
  // header) — `checkSockPathLength`'s own doc comment states the measured
  // limit and why. Without this check, the same failure would still
  // happen, just later, inside the daemon's own `listen()` call, as an
  // `EINVAL` this command could only report as "the session process
  // exited before it was ready", naming no cause at all.
  const lengthCheck = checkSockPathLength(sockPath);
  if (!lengthCheck.ok) {
    stderr.write(
      `Session "${name}" cannot start: its own unix socket path is ${lengthCheck.byteLength} bytes, over ` +
        `this platform's ${lengthCheck.limit}-byte limit on a socket path.\n` +
        `Path: ${sockPath}\n` +
        "Run from a shallower directory, or shorten the project's stateDir, environment name, or session name.\n",
    );
    return 1;
  }

  // A stale socket from a daemon that crashed without cleaning up after
  // itself would otherwise make the new daemon's own `listen()` fail
  // (EADDRINUSE) — the daemon itself also removes any file at this path
  // before listening, but clearing it here too means a startup failure is
  // reported as *this* daemon's own, not blamed on debris from a previous
  // one. The crash log gets the same treatment, and for the same reason:
  // a log left over from a previous failed start must not be misread as
  // this attempt's own reason.
  await rm(sockPath, { force: true }).catch(() => {});
  await rm(crashLogPath, { force: true }).catch(() => {});

  const child = spawnDaemon({ rootDir, env, name, idleTimeoutSeconds, crashLogPath });
  const outcome = await waitForDaemonStartup(child, sockPath, STARTUP_TIMEOUT_MS);
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

  // Not `child.pid`: `spawnDaemon` launches tsx's own CLI, which — at least
  // in this dev/test build, where daemon-entry.ts still runs from `.ts`
  // source rather than a plain compiled script — re-execs the real
  // long-running process as its own child rather than replacing itself, so
  // the pid `spawn()` itself reports can differ from the one that process
  // actually ends up running as (and therefore the one its own lock file,
  // and everything else in this package that signals a session by pid,
  // agrees on). The lock file is the authoritative source either way — by
  // the time the socket exists (just confirmed above), the daemon has
  // already acquired it — so this reads the pid back from there instead of
  // trusting what `spawn()` returned.
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
  const sockPath = sessionSockPath(rootDir, config.stateDir, resolvedEnv.name, name);

  const owner = await liveLockOwner(lockPath);
  if (owner === null) {
    // Nothing alive to ask — clean up whatever debris (a dead lock, a
    // stale socket) is left and succeed quietly, the same convention
    // `runSessionClear` above already follows.
    await rm(sockPath, { force: true }).catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
    return 0;
  }

  const outcome = await sendLiveRequest(sockPath, { kind: "stop" });
  if (!outcome.ok) {
    stderr.write(`Failed to stop session "${name}" (pid ${owner.pid}): ${outcome.message}\n`);
    return 1;
  }
  if (outcome.response.status === "rejected") {
    stderr.write(`Session "${name}" did not stop: ${outcome.response.message}\n`);
    return 1;
  }

  return 0;
}
