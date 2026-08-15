import { InvalidEnvironmentNameError } from "./errors.js";

// Responsibility: the one validity check on a runtime `--env` value that is
// used directly as a filesystem path segment (cache/sessions/<env>/...) *without*
// first being looked up against nukadoko.config.ts's `environments` — i.e.
// `nuka session clear --env <name>`. `nuka do
// --env` doesn't need this check separately: any name failing this pattern
// can never be a key of `environments` either (config/schema.ts's zod schema
// enforces the same regex), so resolve-environment.ts's "unknown
// environment" check already rejects it before any path is built.

const VALID_ENVIRONMENT_NAME = /^[a-z0-9_-]+$/;

export function validateEnvironmentName(name: string): void {
  if (!VALID_ENVIRONMENT_NAME.test(name)) {
    throw new InvalidEnvironmentNameError(name);
  }
}
