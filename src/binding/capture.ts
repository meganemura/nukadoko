import { InvalidCaptureKeyError, UnnamedCaptureError } from "./errors.js";

// Responsibility: parse the text inside one `{...}` token from a pattern
// into its name and type, per docs/spec.md "Typed steps" (`{key:type}`,
// split on the *first* `:` so a custom parameter type name containing a
// dash is never mistaken for part of the split). Pure text parsing, nothing
// else: no dependency on cucumber-expressions or zod, so both `nuka
// check`'s schema checks and (later) `nuka run`'s matching can sit on top
// of it without pulling in the other's concerns.

const CAPTURE_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface Capture {
  readonly key: string;
  /** The type name after the first `:`, e.g. "string", "int", a custom
   * type's name, or "" for the anonymous type (`{key:}`). */
  readonly type: string;
}

/**
 * @param token the text between `{` and `}`, not including the braces.
 * @throws {UnnamedCaptureError} `token` has no `:` at all (an unnamed
 *   parameter — `{string}` on its own).
 * @throws {InvalidCaptureKeyError} the text before the first `:` isn't a
 *   valid identifier.
 */
export function parseCaptureToken(token: string): Capture {
  const colonIndex = token.indexOf(":");
  if (colonIndex === -1) {
    throw new UnnamedCaptureError(token);
  }
  const key = token.slice(0, colonIndex);
  const type = token.slice(colonIndex + 1);
  if (!CAPTURE_KEY_PATTERN.test(key)) {
    throw new InvalidCaptureKeyError(token, key);
  }
  return { key, type };
}
