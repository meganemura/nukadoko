import path from "node:path";

// Responsibility: the filesystem paths a session's storageState and lock
// live at, per docs/spec.md "The state directory" (`sessions/<env>/<name>.json`).
// The environment segment is now a parameter everywhere: it used to be
// hard-coded to "default" because named
// environments were out of scope; `sessionsRootDir` is added alongside it so
// `session list` (session/manage.ts) can enumerate every environment's
// subdirectory instead of assuming there is exactly one.

export function sessionsRootDir(rootDir: string, stateDir: string): string {
  return path.join(rootDir, stateDir, "sessions");
}

export function sessionsDir(rootDir: string, stateDir: string, environment: string): string {
  return path.join(sessionsRootDir(rootDir, stateDir), environment);
}

export function sessionFilePath(
  rootDir: string,
  stateDir: string,
  environment: string,
  name: string,
): string {
  return path.join(sessionsDir(rootDir, stateDir, environment), `${name}.json`);
}

export function sessionLockPath(
  rootDir: string,
  stateDir: string,
  environment: string,
  name: string,
): string {
  return path.join(sessionsDir(rootDir, stateDir, environment), `${name}.lock`);
}
