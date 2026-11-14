// Responsibility: render any error raised while loading a project's
// vocabulary into one stderr line. It lives with discovery, not in the CLI
// vocabulary loader, because a run worker has to print the same line and
// must not import the CLI module to do it. Every error carries its own
// complete message (a config error, a duplicate step, a syntax error thrown
// by importing a broken step file); a non-Error value is stringified.

export function formatVocabularyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
