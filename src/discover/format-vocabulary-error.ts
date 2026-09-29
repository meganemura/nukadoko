import { ConfigError } from "../config/errors.js";
import { DuplicateCompatStepError, DuplicateStepError } from "./errors.js";

// Responsibility: render any error raised while loading a project's
// vocabulary into one stderr line. It lives with discovery, not in the CLI
// vocabulary loader, because a run worker has to print the same line and
// must not import the CLI module to do it. ConfigError,
// DuplicateStepError, and DuplicateCompatStepError already carry a
// complete message; anything else (a syntax error thrown by importing a
// broken step file, for example) falls back to its own message.

export function formatVocabularyError(error: unknown): string {
  if (
    error instanceof ConfigError ||
    error instanceof DuplicateStepError ||
    error instanceof DuplicateCompatStepError
  ) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
