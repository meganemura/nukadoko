import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Responsibility: making the project's own tsconfig.json `include` reach
// the steps directory and the config file `nuka init` writes, so the
// project's type check sees the step files. Reads and writes tsconfig.json
// and nothing else.
//
// `init` appends the missing entries in place, so the array gains them in
// its own layout and every other byte stays, comments and trailing commas
// included: tsconfig.json is JSONC (`tsc --init` writes comments), and no
// rewrite through a JSON value keeps a comment. The parser and the edit
// read the text through one scanner, so they agree on what is a comment.
//
// Every other case stays silent, because each is a claim that can end only
// one way: an `include` entry with a wildcard in it counts as covering, a
// tsconfig with no `include` of its own (TypeScript's default, or one
// inherited through `extends`) is left alone, and so is a file that does
// not parse. An edit nobody needed would teach people to distrust the
// ones they did.

/** One span of JSONC text. Whitespace between spans is not a token;
 * `literal` is a run of anything else (a number, `true`, or a stray
 * character JSON.parse will refuse). */
type Token = { kind: "string" | "comment" | "punct" | "literal"; start: number; end: number };

const PUNCT = new Set(["{", "}", "[", "]", ":", ","]);

function scan(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const start = i;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      i = stringEnd(text, i);
      tokens.push({ kind: "string", start, end: i });
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      tokens.push({ kind: "comment", start, end: i });
    } else if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? text.length : close + 2;
      tokens.push({ kind: "comment", start, end: i });
    } else if (PUNCT.has(ch)) {
      i += 1;
      tokens.push({ kind: "punct", start, end: i });
    } else {
      i += 1;
      while (i < text.length && !/[\s"{}[\]:,]/.test(text[i] ?? "") && !/^\/[/*]/.test(text.slice(i, i + 2))) {
        i += 1;
      }
      tokens.push({ kind: "literal", start, end: i });
    }
  }
  return tokens;
}

/** The tokens JSON.parse would see: no comments. */
function significant(text: string): Token[] {
  return scan(text).filter((token) => token.kind !== "comment");
}

function isPunct(text: string, token: Token | undefined, ch: string): boolean {
  return token?.kind === "punct" && text[token.start] === ch;
}

/**
 * Parses JSON with comments and trailing commas, the dialect tsconfig.json
 * is written in (`tsc --init` writes comments). Comments and commas inside
 * a string are left alone, which a regular expression over the whole text
 * cannot do: `"$schema": "https://..."` holds a `//`.
 */
export function parseJsonc(text: string): unknown {
  const tokens = significant(text);
  const kept = tokens.filter(
    (token, index) =>
      !(isPunct(text, token, ",") && (isPunct(text, tokens[index + 1], "}") || isPunct(text, tokens[index + 1], "]"))),
  );
  // A space between tokens keeps two literals apart, so `1 2` still fails.
  return JSON.parse(kept.map((token) => text.slice(token.start, token.end)).join(" "));
}

function segments(value: string): string[] {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
}

/**
 * Whether one `include` entry may cover `target` (a root-relative file
 * path). A literal entry covers the file itself and everything under a
 * directory it names. Any wildcard counts as covering, from the segment it
 * appears in on: telling exactly what `*.ts` or `src/**` matches is
 * TypeScript's job, and a guess here would be an edit that can be wrong.
 */
export function includeMayCover(entry: string, target: string): boolean {
  const entrySegments = segments(entry);
  const targetSegments = segments(target);
  for (let i = 0; i < entrySegments.length; i += 1) {
    const segment = entrySegments[i] ?? "";
    if (/[*?]/.test(segment)) return true;
    if (segment !== targetSegments[i]) return false;
  }
  return true;
}

/**
 * The `include` entries to add so the type check sees the steps directory
 * and the config file, in that order, or an empty list when `include`
 * already covers both.
 */
export function missingIncludeEntries(
  include: readonly string[],
  featuresDir: string,
  configFileName: string,
): string[] {
  const featuresPosix = segments(featuresDir).join("/");
  const wanted = [
    { target: `${featuresPosix}/steps/step.ts`, entry: `${featuresPosix}/**/*` },
    { target: configFileName, entry: configFileName },
  ];
  return wanted
    .filter(({ target }) => !include.some((entry) => includeMayCover(entry, target)))
    .map(({ entry }) => entry);
}

/**
 * Appends `entries` to the top-level `include` array of `text`, a JSONC
 * object whose `include` is an array, and changes nothing else. A
 * multi-line array gets one entry per line at its last element's
 * indentation, after any comment that ends that line; a one-line array
 * gets them on that line, after the separator it already uses. An array
 * that ends in a trailing comma keeps one after the new last entry.
 */
export function appendIncludeEntries(text: string, entries: readonly string[]): string {
  if (entries.length === 0) return text;
  const tokens = scan(text);
  const { open, close } = includeArraySpan(text, tokens);
  const openAt = tokens[open]?.end ?? 0;
  const closeAt = tokens[close]?.start ?? 0;
  const quoted = entries.map((entry) => JSON.stringify(entry));
  const inside = tokens.slice(open + 1, close).filter((token) => token.kind !== "comment");
  if (inside.length === 0) {
    const rest = text.slice(openAt, closeAt).trim() === "" ? closeAt : openAt;
    return `${text.slice(0, openAt)}${quoted.join(", ")}${text.slice(rest)}`;
  }
  const trailing = isPunct(text, inside[inside.length - 1], ",");
  const last = inside[inside.length - (trailing ? 2 : 1)];
  if (last === undefined) throw new Error("tsconfig.json's include array starts with a comma");
  const lastEnd = last.end;
  const anchor = trailing ? (inside[inside.length - 1]?.end ?? lastEnd) : lastEnd;
  const before = text.slice(openAt, lastEnd);
  const lineBreak = before.lastIndexOf("\n");
  let space: string;
  let insertAt = anchor;
  if (lineBreak !== -1) {
    const newline = before[lineBreak - 1] === "\r" ? "\r\n" : "\n";
    const lineStart = openAt + lineBreak + 1;
    space = `${newline}${/^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ""}`;
    insertAt = lineEndAfter(text, tokens, anchor, closeAt) ?? anchor;
  } else {
    // Only the commas between elements show the file's style; a lone
    // trailing comma says nothing about it.
    space = /,[ \t]/.test(before) || !before.includes(",") ? " " : "";
  }
  const body = quoted.join(`,${space}`);
  if (trailing) return `${text.slice(0, insertAt)}${space}${body},${text.slice(insertAt)}`;
  return `${text.slice(0, lastEnd)},${text.slice(lastEnd, insertAt)}${space}${body}${text.slice(insertAt)}`;
}

/** Where the line holding `from` ends (before its `\r\n` or `\n`) when
 * only whitespace and comments sit between `from` and that line break and
 * the break comes before `limit`; a comment that ends the last element's
 * line then stays on that line. */
function lineEndAfter(text: string, tokens: readonly Token[], from: number, limit: number): number | undefined {
  let i = from;
  for (const token of tokens) {
    if (token.end <= from) continue;
    if (token.start >= limit) break;
    const gapBreak = text.slice(i, token.start).indexOf("\n");
    if (gapBreak !== -1) return newlineStart(text, i + gapBreak);
    if (token.kind !== "comment") return undefined;
    i = token.end;
  }
  const gapBreak = text.slice(i, limit).indexOf("\n");
  return gapBreak === -1 ? undefined : newlineStart(text, i + gapBreak);
}

function newlineStart(text: string, at: number): number {
  return text[at - 1] === "\r" ? at - 1 : at;
}

/** The indexes in `tokens` of the `[` and `]` of the top-level `include`
 * value. The last `include` key wins, as it does for JSON.parse. */
function includeArraySpan(text: string, tokens: readonly Token[]): { open: number; close: number } {
  const indexes = tokens.flatMap((token, index) => (token.kind === "comment" ? [] : [index]));
  const at = (k: number): Token | undefined => tokens[indexes[k] ?? -1];
  let depth = 0;
  let open = -1;
  for (let k = 0; k < indexes.length; k += 1) {
    const token = at(k);
    if (token === undefined) continue;
    if (token.kind === "string" && depth === 1 && isPunct(text, at(k + 1), ":")) {
      if (JSON.parse(text.slice(token.start, token.end)) === "include") open = indexes[k + 2] ?? -1;
    }
    if (isPunct(text, token, "{") || isPunct(text, token, "[")) depth += 1;
    if (isPunct(text, token, "}") || isPunct(text, token, "]")) depth -= 1;
  }
  if (!isPunct(text, tokens[open], "[")) throw new Error("tsconfig.json has no top-level include array");
  return { open, close: matchingBracket(text, tokens, open) };
}

function stringEnd(text: string, start: number): number {
  let j = start + 1;
  while (j < text.length && text[j] !== '"') {
    j += text[j] === "\\" ? 2 : 1;
  }
  return j + 1;
}

function matchingBracket(text: string, tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (isPunct(text, token, "[") || isPunct(text, token, "{")) depth += 1;
    if (isPunct(text, token, "]") || isPunct(text, token, "}")) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("tsconfig.json's include array is not closed");
}

/** What `init` did about tsconfig.json: wrote the entries, or nothing to
 * say (see this file's header for each silent case). */
export type TsconfigIncludeOutcome = { kind: "written" } | { kind: "silent" };

/** Adds the missing `include` entries to tsconfig.json in place. */
export async function ensureTsconfigInclude(
  rootDir: string,
  featuresDir: string,
  configFileName: string,
): Promise<TsconfigIncludeOutcome> {
  const tsconfigPath = path.join(rootDir, "tsconfig.json");
  let text: string;
  let parsed: unknown;
  try {
    text = await readFile(tsconfigPath, "utf8");
    parsed = parseJsonc(text);
  } catch {
    return { kind: "silent" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "silent" };
  const include = (parsed as { include?: unknown }).include;
  if (!Array.isArray(include) || !include.every((entry): entry is string => typeof entry === "string")) {
    return { kind: "silent" };
  }
  const missing = missingIncludeEntries(include, featuresDir, configFileName);
  if (missing.length === 0) return { kind: "silent" };
  await writeFile(tsconfigPath, appendIncludeEntries(text, missing));
  return { kind: "written" };
}
