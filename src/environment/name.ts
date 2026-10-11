import { InvalidEnvironmentNameError } from "./errors.js";

// Responsibility: the validity check on a runtime `--env` value before it
// is used as a filesystem path segment (cache/sessions/<env>/...). `nuka
// session clear --env` still builds that path for an environment removed
// from the config, once session files are left under the name, so a name
// that fails this pattern has to be rejected before any path is built.
// `nuka do --env` doesn't need this check separately: any name failing
// this pattern can never be a key of `environments` either
// (config/schema.ts's zod schema enforces the same regex), so
// resolve-environment.ts's "unknown environment" check already rejects it
// before any path is built.

const VALID_ENVIRONMENT_NAME = /^[a-z0-9_-]+$/;

export function validateEnvironmentName(name: string): void {
  if (!VALID_ENVIRONMENT_NAME.test(name)) {
    throw new InvalidEnvironmentNameError(name);
  }
}
