import { loadConfig } from "../config/load-config.js";
import { clearAllSessions, clearSession, listSessions } from "../session/manage.js";
import { validateSessionName } from "../session/name.js";
import { formatVocabularyError } from "./vocabulary.js";
import type { WritableSink } from "./writable-sink.js";

// Responsibility: `nuka session list`/`clear`'s CLI-facing wiring, kept out
// of run-cli.ts so it's unit-testable without going through yargs (same
// split as cli/do.ts vs cli/run-cli.ts). Both commands need the project's
// stateDir (for sessions/default/) but never touch its step vocabulary, so
// neither loads or discovers steps the way `do`/`steps`/`describe` do.

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
      stdout.write(`${session.name}\t${session.updated_at}\n`);
    }
  }
  // Empty is a valid, if unhelpful, answer (this task's spec: "0 件でも
  // exit 0") — never an error.
  return 0;
}

export interface RunSessionClearOptions {
  rootDir: string;
  /** `null` clears every session for the default environment. */
  name: string | null;
  stdout: WritableSink;
  stderr: WritableSink;
}

export async function runSessionClear(options: RunSessionClearOptions): Promise<number> {
  const { rootDir, name, stderr } = options;

  let config;
  try {
    config = await loadConfig(rootDir);
  } catch (error) {
    stderr.write(`${formatVocabularyError(error)}\n`);
    return 1;
  }

  try {
    if (name === null) {
      await clearAllSessions(rootDir, config.stateDir);
    } else {
      validateSessionName(name);
      await clearSession(rootDir, config.stateDir, name);
    }
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // Silent on success, like `rm`: stdout is reserved for `do`'s receipt and
  // `list`'s listing (this task's spec's stdout discipline); a successful
  // `clear` has nothing structured to report.
  return 0;
}
