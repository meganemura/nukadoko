import { InvalidSessionNameError } from "./errors.js";

// Responsibility: the one validity check on a session name, shared by
// `nuka do --session` and `nuka session clear <name>`. Names map directly
// onto file names under
// cache/sessions/default/<name>.{json,lock}, so anything outside
// `[a-z0-9_-]+` — most importantly `.`/`/` — could escape that directory
// (e.g. `--session ../../etc`); rejecting it here in setup, before any path
// is built, is cheaper and more certain than trying to sanitize a path later.

const VALID_SESSION_NAME = /^[a-z0-9_-]+$/;

export function validateSessionName(name: string): void {
  if (!VALID_SESSION_NAME.test(name)) {
    throw new InvalidSessionNameError(name);
  }
}
