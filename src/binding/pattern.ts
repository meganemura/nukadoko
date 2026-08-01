import { type Capture, parseCaptureToken } from "./capture.js";
import { UnterminatedCaptureError } from "./errors.js";

// Re-exported so callers (src/binding/expression.ts, src/check/binding-
// check.ts) can get both the stripping function and the type it returns
// captures as from this one module, without also importing capture.ts.
export type { Capture };

// Responsibility: strip the `{key:type}` names cucumber-expressions itself
// knows nothing about, turning a nukadoko pattern into the plain `{type}`
// text the official parser accepts (docs/spec.md "Typed steps": "the syntax
// owner is unchanged, names are a thin layer above it"). Walks the pattern
// text once, left to right, treating `\X` (any backslash followed by any
// character) as a single escaped unit never inspected for brace meaning —
// the same escaping cucumber-expressions' own tokenizer uses for `\{`/`\}` —
// so this module never needs to understand the rest of that syntax
// (optional groups, alternation) to find the `{...}` tokens correctly.
// Captures are recorded in the order encountered, the same order
// Argument.build() (cucumber-expressions) returns matched values in — what
// lets `nuka run` zip captures back onto keys later without this module
// knowing anything about matching.

export interface StrippedPattern {
  readonly strippedPattern: string;
  readonly captures: readonly Capture[];
}

/**
 * @throws {UnnamedCaptureError} a `{...}` token has no `:` (unnamed
 *   parameter).
 * @throws {InvalidCaptureKeyError} a `{...}` token's name isn't a valid
 *   identifier.
 * @throws {UnterminatedCaptureError} an unescaped `{` has no matching `}`.
 */
export function stripCaptureNames(pattern: string): StrippedPattern {
  let strippedPattern = "";
  const captures: Capture[] = [];

  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      strippedPattern += pattern.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end === -1) {
        throw new UnterminatedCaptureError(pattern.slice(i));
      }
      const capture = parseCaptureToken(pattern.slice(i + 1, end));
      captures.push(capture);
      strippedPattern += `{${capture.type}}`;
      i = end + 1;
      continue;
    }
    strippedPattern += ch;
    i += 1;
  }

  return { strippedPattern, captures };
}
