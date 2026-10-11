// Responsibility: the KEY=VALUE parser both ctx.env (src/context/env.ts)
// and the secret set (src/secrets/build-secret-set.ts) share. It lives in
// its own module so secrets can reuse the format without importing the
// context module: context already depends on secrets, and the reverse edge
// was only this function.
//
// Node's util.parseEnv is not used. It was added in Node 20.12.0, and this
// package accepts Node 20, so the function is missing on part of the
// supported range. Calling it only when present would make one file parse
// differently on two machines. The scanner below is the format docs/spec.md
// describes. It matches dotenv's default parser for comments, quotes,
// backslash escapes, and values that span lines. The separator is "=" only.
// A line that is not a blank, a comment, or part of a binding is returned
// by skippedEnvFileLines so nuka check can name it. The run still loads
// every binding it could read.

const DOUBLE_QUOTE = '"';
const SINGLE_QUOTE = "'";
const BACKTICK = "`";

interface EnvFileScan {
  readonly values: Record<string, string>;
  readonly skippedLines: readonly number[];
}

export function parseEnvFile(content: string): Record<string, string> {
  return scanEnvFile(content).values;
}

/** 1-based line numbers of lines that were not loaded. Blank lines and
 * comments are not included. A line inside a quoted value is not included
 * either: it is part of that value. */
export function skippedEnvFileLines(content: string): readonly number[] {
  return scanEnvFile(content).skippedLines;
}

function scanEnvFile(content: string): EnvFileScan {
  const text = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const values: Record<string, string> = {};
  const skippedLines: number[] = [];
  let index = 0;
  let line = 1;

  while (index < text.length) {
    const lineNo = line;
    while (isHorizontalSpace(text.charAt(index))) index += 1;
    const char = text.charAt(index);
    if (char === "") break;
    if (char === "\n") {
      index += 1;
      line += 1;
      continue;
    }
    if (char === "#") {
      const rest = skipRestOfLine(text, index, line);
      index = rest.index;
      line = rest.line;
      continue;
    }

    if (text.startsWith("export", index) && isHorizontalSpace(text.charAt(index + "export".length))) {
      index += "export".length;
      while (isHorizontalSpace(text.charAt(index))) index += 1;
    }

    const keyStart = index;
    while (index < text.length && text.charAt(index) !== "=" && text.charAt(index) !== "\n") {
      index += 1;
    }
    if (text.charAt(index) !== "=") {
      skippedLines.push(lineNo);
      const rest = skipRestOfLine(text, index, line);
      index = rest.index;
      line = rest.line;
      continue;
    }
    const key = text.slice(keyStart, index).trim();
    if (key === "") {
      skippedLines.push(lineNo);
      const rest = skipRestOfLine(text, index, line);
      index = rest.index;
      line = rest.line;
      continue;
    }
    index += 1;
    while (isHorizontalSpace(text.charAt(index))) index += 1;

    const quoted = readQuoted(text, index, line);
    if (quoted !== undefined) {
      values[key] = quoted.value;
      index = quoted.index;
      line = quoted.line;
      continue;
    }

    let end = index;
    while (end < text.length && text.charAt(end) !== "\n" && text.charAt(end) !== "#") end += 1;
    values[key] = text.slice(index, end).trim();
    const rest = skipRestOfLine(text, end, line);
    index = rest.index;
    line = rest.line;
  }

  return { values, skippedLines };
}

function isHorizontalSpace(char: string): boolean {
  return char === " " || char === "\t";
}

function isQuote(char: string): boolean {
  return char === DOUBLE_QUOTE || char === SINGLE_QUOTE || char === BACKTICK;
}

interface QuotedValue {
  readonly value: string;
  readonly index: number;
  readonly line: number;
}

function readQuoted(text: string, start: number, line: number): QuotedValue | undefined {
  const quote = text.charAt(start);
  if (!isQuote(quote)) return undefined;
  let index = start + 1;
  let lineNow = line;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      index += 1;
      if (index < text.length) {
        if (text.charAt(index) === "\n") lineNow += 1;
        index += 1;
      }
      continue;
    }
    if (char === "\n") {
      lineNow += 1;
      index += 1;
      continue;
    }
    if (char !== quote) {
      index += 1;
      continue;
    }
    const raw = text.slice(start + 1, index);
    let after = index + 1;
    while (isHorizontalSpace(text.charAt(after))) after += 1;
    const next = text.charAt(after);
    if (next !== "" && next !== "\n" && next !== "#") return undefined;
    // dotenv expands \n and \r after the quotes come off, and a backslash
    // in front of that pair is not special. "\\n" in a double-quoted value
    // is a backslash followed by a newline. Treating the doubled backslash
    // as an escape of its own would disagree with files people already have.
    const value = quote === DOUBLE_QUOTE ? raw.replaceAll("\\n", "\n").replaceAll("\\r", "\r") : raw;
    if (next === "#") {
      while (after < text.length && text.charAt(after) !== "\n") after += 1;
    }
    if (text.charAt(after) === "\n") {
      after += 1;
      lineNow += 1;
    }
    return { value, index: after, line: lineNow };
  }
  return undefined;
}

function skipRestOfLine(text: string, index: number, line: number): { index: number; line: number } {
  let cursor = index;
  while (cursor < text.length && text.charAt(cursor) !== "\n") cursor += 1;
  if (cursor < text.length) return { index: cursor + 1, line: line + 1 };
  return { index: cursor, line };
}
