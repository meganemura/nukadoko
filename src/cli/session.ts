import { versioned } from "../record/schema-version.js";
import { readdir } from "node:fs/promises";
import { loadConfig } from "../config/load-config.js";
import { validateEnvironmentName } from "../environment/name.js";
import { DEFAULT_ENVIRONMENT_NAME, resolveEnvironment } from "../environment/resolve-environment.js";
import { clearAllSessions, clearSession, listSessions } from "../session/manage.js";
import { validateSessionName } from "../session/name.js";
import { sessionsDir } from "../session/paths.js";
import { failInShape, helpFor, refuse } from "./refusal.js";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: `nuka session list`/`clear`'s CLI-facing wiring, kept out
// of run-cli.ts so it's unit-testable without going through yargs (same
// split as cli/do.ts vs cli/run-cli.ts). Both only touch the session files
// `nuka do --session` leaves under cache/sessions/<env>/.

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
    return refuse({ json, stdout, stderr }, error, helpFor("session list"));
  }

  const sessions = await listSessions(rootDir, config.stateDir);

  if (json) {
    stdout.write(`${JSON.stringify(versioned("sessions", { sessions }), null, 2)}\n`);
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

/** A session file or a lock is something `clear` can still delete. */
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
  const { rootDir, name, env, stdout, stderr } = options;
  const environment = env ?? DEFAULT_ENVIRONMENT_NAME;
  const sinks = { json: false, stdout, stderr };

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    return refuse(sinks, error, helpFor("session clear"));
  }

  try {
    validateEnvironmentName(environment);
    // An explicit `--env` the config does not define is refused, as `nuka
    // do --env` refuses it. The exception is files still
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
    if (name !== null) validateSessionName(name);
  } catch (error) {
    return refuse(sinks, error, helpFor("session clear"));
  }

  try {
    if (name === null) {
      await clearAllSessions(rootDir, config.stateDir, environment);
    } else {
      await clearSession(rootDir, config.stateDir, environment, name);
    }
  } catch (error) {
    return failInShape(sinks, error, helpFor("session clear"));
  }

  // Silent on success for a known environment, like `rm`: stdout is
  // reserved for `do`'s step record and `list`'s listing. The one stderr
  // line above is the unknown-environment case, written before this return.
  return 0;
}
