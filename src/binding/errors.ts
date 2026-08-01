// Responsibility: the error types raised while turning a pattern's raw
// `{...}` tokens into named captures (capture.ts, pattern.ts). Kept separate
// from the modules that throw them so callers (today: src/check/binding-
// check.ts; later: `nuka run`'s matching layer) can `instanceof` them without
// pulling in anything else — same convention as config/errors.ts,
// discover/errors.ts, environment/errors.ts, session/errors.ts.

/** A `{...}` token had no `:` at all — docs/spec.md "Typed steps" requires
 * every parameter in a pattern to be named (`{key:type}`); a bare `{string}`/
 * `{color}` is the one thing that can silently swap two same-typed captures
 * when a schema's keys are reordered, so it is always a check error, never a
 * warning. */
export class UnnamedCaptureError extends Error {
  readonly token: string;

  constructor(token: string) {
    super(
      `Parameter "{${token}}" has no name; every parameter in a pattern must be written {key:type} (docs/spec.md "Typed steps")`,
    );
    this.name = "UnnamedCaptureError";
    this.token = token;
  }
}

/** The text before `{...}`'s first `:` isn't a valid identifier. */
export class InvalidCaptureKeyError extends Error {
  readonly token: string;
  readonly key: string;

  constructor(token: string, key: string) {
    super(`Parameter "{${token}}" has an invalid name "${key}": must match [a-zA-Z_][a-zA-Z0-9_]*`);
    this.name = "InvalidCaptureKeyError";
    this.token = token;
    this.key = key;
  }
}

/** A pattern has an unescaped `{` with no matching `}` before the pattern
 * ends — malformed input that would otherwise make the scan in pattern.ts
 * run past the end of the string. */
export class UnterminatedCaptureError extends Error {
  readonly remainder: string;

  constructor(remainder: string) {
    super(`Pattern has an unterminated "{" starting at: ${remainder}`);
    this.name = "UnterminatedCaptureError";
    this.remainder = remainder;
  }
}
