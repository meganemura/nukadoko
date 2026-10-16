import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Responsibility: making the project's own tsconfig.json `include` reach
// the steps directory and the config file `nuka init` writes, so the
// project's type check sees the step files. Reads and writes tsconfig.json
// and nothing else.
//
// `init` appends the missing entries itself only when the file is plain
// JSON, so the edit can be made in place: the array gains the entries in
// its own layout and every other byte stays. A file with comments or
// trailing commas gets a one-line hint instead, since no rewrite through a
// JSON value keeps a comment, and editing JSONC text in place is a second
// parser this tool has no other use for.
//
// Every other case stays silent, because each is a claim that can end only
// one way: an `include` entry with a wildcard in it counts as covering, a
// tsconfig with no `include` of its own (TypeScript's default, or one
// inherited through `extends`) is left alone, and so is a file that does
// not parse. A false hint, or an edit nobody needed, would teach people to
// ignore the true ones.

/**
 * Parses JSON with comments and trailing commas, the dialect tsconfig.json
 * is written in (`tsc --init` writes comments). Comments and commas inside
 * a string are left alone, which a regular expression over the whole text
 * cannot do: `"$schema": "https://..."` holds a `//`.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return JSON.parse(stripTrailingCommas(out));
}

function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
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
 * TypeScript's job, and a guess here would be a hint that can be wrong.
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
 * Appends `entries` to the top-level `include` array of `text`, a strict
 * JSON object whose `include` is an array, and changes nothing else. A
 * multi-line array gets one entry per line at its last element's
 * indentation; a one-line array gets them on that line, after the
 * separator it already uses.
 */
export function appendIncludeEntries(text: string, entries: readonly string[]): string {
  const { open, close } = includeArraySpan(text);
  const inner = text.slice(open + 1, close);
  const quoted = entries.map((entry) => JSON.stringify(entry));
  if (inner.trim() === "") {
    return `${text.slice(0, open + 1)}${quoted.join(", ")}${text.slice(close)}`;
  }
  const content = inner.trimEnd();
  const lastEnd = open + 1 + content.length;
  const lastLineStart = content.lastIndexOf("\n");
  let separator: string;
  if (lastLineStart !== -1) {
    const newline = content[lastLineStart - 1] === "\r" ? "\r\n" : "\n";
    const indent = /^[ \t]*/.exec(content.slice(lastLineStart + 1))?.[0] ?? "";
    separator = `,${newline}${indent}`;
  } else {
    separator = /,[ \t]/.test(inner) || !inner.includes(",") ? ", " : ",";
  }
  const added = quoted.map((entry) => `${separator}${entry}`).join("");
  return `${text.slice(0, lastEnd)}${added}${text.slice(lastEnd)}`;
}

/** The positions of the `[` and `]` of the top-level `include` value. The
 * last `include` key wins, as it does for JSON.parse. */
function includeArraySpan(text: string): { open: number; close: number } {
  let depth = 0;
  let open = -1;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = stringEnd(text, i);
      if (depth === 1) {
        let j = end;
        while (/\s/.test(text[j] ?? "")) j += 1;
        if (text[j] === ":" && JSON.parse(text.slice(i, end)) === "include") {
          j += 1;
          while (/\s/.test(text[j] ?? "")) j += 1;
          open = j;
        }
      }
      i = end;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    if (ch === "}" || ch === "]") depth -= 1;
    i += 1;
  }
  if (text[open] !== "[") throw new Error("tsconfig.json has no top-level include array");
  return { open, close: matchingBracket(text, open) };
}

function stringEnd(text: string, start: number): number {
  let j = start + 1;
  while (j < text.length && text[j] !== '"') {
    j += text[j] === "\\" ? 2 : 1;
  }
  return j + 1;
}

function matchingBracket(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = stringEnd(text, i);
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error("tsconfig.json's include array is not closed");
}

/** What `init` did about tsconfig.json: wrote the entries, or has a hint
 * line (without a trailing newline) to print, or nothing to say. */
export type TsconfigIncludeOutcome = { kind: "written" } | { kind: "hint"; line: string } | { kind: "silent" };

/** Adds the missing `include` entries to tsconfig.json when the file is
 * plain JSON, and otherwise says which ones to add (see this file's header
 * for each case). */
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
  if (isStrictJson(text)) {
    await writeFile(tsconfigPath, appendIncludeEntries(text, missing));
    return { kind: "written" };
  }
  const quoted = missing.map((entry) => JSON.stringify(entry)).join(" and ");
  const paths = missing.length === 1 ? "this path" : "these paths";
  return {
    kind: "hint",
    line: `tsconfig.json's include leaves out ${paths}, so tsc does not check them; nuka init left the file alone because it holds comments or trailing commas, so add ${quoted} to it`,
  };
}

function isStrictJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
