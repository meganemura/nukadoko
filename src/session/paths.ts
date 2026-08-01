import path from "node:path";

// Responsibility: the filesystem paths a session's storageState and lock
// live at, per docs/spec.md "The state directory"
// (`sessions/<env>/<name>.json`). The environment segment is hard-coded to
// "default": named environments (`--env`) are explicitly out of this task's
// scope (this task spec, decision 6), and receipts already record
// `environment: "default"` for the same reason. Using the real
// `sessions/<env>/` layout now — rather than e.g. `sessions/<name>.json` —
// means no path migration is needed once `--env` lands; only this module's
// hard-coded segment needs to become a parameter.

const DEFAULT_ENVIRONMENT = "default";

export function sessionsDir(rootDir: string, stateDir: string): string {
  return path.join(rootDir, stateDir, "sessions", DEFAULT_ENVIRONMENT);
}

export function sessionFilePath(rootDir: string, stateDir: string, name: string): string {
  return path.join(sessionsDir(rootDir, stateDir), `${name}.json`);
}

export function sessionLockPath(rootDir: string, stateDir: string, name: string): string {
  return path.join(sessionsDir(rootDir, stateDir), `${name}.lock`);
}
