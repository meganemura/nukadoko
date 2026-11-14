import { parseCaptureToken } from "./capture.js";

// Responsibility: a feature line a nukadoko pattern matches, for a finding
// that tells an agent which line to add. The inverse of matching, for the
// cucumber-expression syntax a typed pattern uses: a capture becomes the
// value given for its key, an optional group is dropped (or kept, when it
// stands as a word of its own, so the line has no double space), an
// alternation keeps its first alternative, and an escape gives its character.
// Boundary: reads the pattern text only. It never builds an expression or
// runs a parameter type, so a custom type's capture gets the value as given.

/**
 * `{key:type}` becomes `filled.get(key)`, quoted for `string`, or `<key>`
 * when `filled` has no value for it that the capture could match. The rest
 * of the line is the pattern's literal text. Pure.
 */
export function exampleLine(pattern: string, filled: ReadonlyMap<string, string>): string {
  let line = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) {
      line += pattern[i + 1];
      i += 2;
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end === -1) return line + pattern.slice(i);
      line += captureText(pattern.slice(i + 1, end), filled);
      i = end + 1;
    } else if (ch === "(") {
      const end = skipOptional(pattern, i);
      const alone = (i === 0 || pattern[i - 1] === " ") && (end >= pattern.length || pattern[end] === " ");
      if (alone) line += pattern.slice(i + 1, end - 1).replace(/\\(.)/g, "$1");
      i = end;
    } else if (ch === "/") {
      i = skipAlternatives(pattern, i);
    } else {
      line += ch;
      i += 1;
    }
  }
  return line;
}

/** A token that does not parse is kept as written: its pattern error is
 * binding-check's finding, and a finding that suggests a line must not
 * fail over it. */
function captureText(token: string, filled: ReadonlyMap<string, string>): string {
  let capture: ReturnType<typeof parseCaptureToken>;
  try {
    capture = parseCaptureToken(token);
  } catch {
    return `{${token}}`;
  }
  const given = filled.get(capture.key);
  // {word} matches no space, so a holder a {string} capture read elsewhere
  // ("Aki Tanaka") would make a line this step never matches.
  const fits = given !== undefined && !(capture.type === "word" && (given === "" || /\s/.test(given)));
  const value = fits ? given : `<${capture.key}>`;
  return capture.type === "string" ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** The index after the `)` that closes the optional group opening at `start`. */
function skipOptional(pattern: string, start: number): number {
  let i = start + 1;
  while (i < pattern.length && pattern[i] !== ")") i += pattern[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** The index where the alternatives after the `/` at `start` end: an
 * alternation runs to the next space or capture. */
function skipAlternatives(pattern: string, start: number): number {
  let i = start + 1;
  while (i < pattern.length && pattern[i] !== " " && pattern[i] !== "{") {
    if (pattern[i] === "\\") i += 2;
    else if (pattern[i] === "(") i = skipOptional(pattern, i);
    else i += 1;
  }
  return i;
}
