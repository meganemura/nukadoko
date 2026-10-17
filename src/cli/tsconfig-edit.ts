import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// Responsibility: the two tsconfig.json edits `nuka init` makes so the
// project's type check reads the step files as nuka loads them: `include`
// reaches the steps directory and the config file, and `compilerOptions`
// accepts an import that names a `.ts` file (the spelling `nuka scaffold`
// writes when tsc accepts it, because Node resolves only a file that
// exists). It also answers, for `nuka scaffold`, whether the project's tsc
// accepts that spelling as tsconfig.json stands. Reads and writes
// tsconfig.json and nothing else.
//
// The option is `rewriteRelativeImportExtensions` (TypeScript 5.7 and
// later). `allowImportingTsExtensions` also accepts the import, but tsc
// refuses it unless `noEmit` is set, and a project that type checks with
// `tsc --noEmit` on the command line has no `noEmit` in the file to read.
// The rewrite option is valid with emit and without, and it changes only
// the output of an import that names a `.ts` file. A file that already
// names either option, to any value, has made the choice, and is left
// alone.
//
// `init` appends what is missing in place, so the array or object gains it
// in its own layout and every other byte stays, comments and trailing
// commas included: tsconfig.json is JSONC (`tsc --init` writes comments), and no
// rewrite through a JSON value keeps a comment. The parser and the edit
// read the text through one scanner, so they agree on what is a comment.
//
// `extends` is followed, because a base file can make the choice for the
// project: when any file in the chain names either option, `init` adds
// nothing. When the project's own file has no `compilerOptions`, its options
// come only from the chain, and `init` writes no new object into it; it says
// on stderr what the chain lacks, or that it could not read the chain, so
// the setting is never skipped without a word.
//
// Every other case stays silent, because each is a claim that can end only
// one way: an `include` entry with a wildcard in it counts as covering, a
// tsconfig with no `include`, or with neither `compilerOptions` nor
// `extends` (TypeScript's default), is left alone, and so is a file that
// does not parse. An edit nobody needed would teach people to distrust the
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
  const { open, close } = topLevelSpan(text, tokens, "include", "[");
  return appendItems(text, tokens, open, close, entries.map((entry) => JSON.stringify(entry)));
}

/** Adds `key: true` as the last member of the top-level `compilerOptions`
 * object of `text`, in the layout `appendIncludeEntries` keeps. */
export function appendCompilerOption(text: string, key: string): string {
  const tokens = scan(text);
  const { open, close } = topLevelSpan(text, tokens, "compilerOptions", "{");
  return appendItems(text, tokens, open, close, [`${JSON.stringify(key)}: true`]);
}

function ownCompilerOptions(tsconfig: unknown): object | undefined {
  if (typeof tsconfig !== "object" || tsconfig === null) return undefined;
  const options = (tsconfig as { compilerOptions?: unknown }).compilerOptions;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return undefined;
  return options;
}

function namesTsExtensionOption(tsconfig: unknown): boolean {
  const options = ownCompilerOptions(tsconfig);
  return options !== undefined && ("allowImportingTsExtensions" in options || "rewriteRelativeImportExtensions" in options);
}

/** Whether `init` adds `TS_EXTENSION_OPTION` to this parsed tsconfig: it
 * has a `compilerOptions` object of its own that names neither option. */
export function needsTsExtensionOption(tsconfig: unknown): boolean {
  return ownCompilerOptions(tsconfig) !== undefined && !namesTsExtensionOption(tsconfig);
}

export const TS_EXTENSION_OPTION = "rewriteRelativeImportExtensions";

/** What the files a tsconfig extends say about the option: one of them names
 * it, none does, or one of them could not be read (the specifier as the file
 * wrote it). */
export type ExtendsChain = { kind: "names-option" } | { kind: "lacks-option" } | { kind: "unread"; specifier: string };

function extendsSpecifiers(tsconfig: unknown): string[] | undefined {
  if (typeof tsconfig !== "object" || tsconfig === null || !("extends" in tsconfig)) return [];
  const value = (tsconfig as { extends?: unknown }).extends;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")) return value;
  return undefined;
}

/** The file TypeScript reads for an `extends` specifier: a path, with
 * `.json` added when the path as written does not exist, or a package
 * specifier resolved from the extending file's directory, as written, with
 * `.json`, or as a package's `tsconfig.json`. A package specifier that
 * resolves to anything but a JSON file is a package's code, not its
 * tsconfig, so the next spelling is tried. */
export function resolveExtends(specifier: string, fromDir: string): string | undefined {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    const target = path.resolve(fromDir, specifier);
    if (existsSync(target)) return target;
    return existsSync(`${target}.json`) ? `${target}.json` : undefined;
  }
  const require = createRequire(path.join(fromDir, "tsconfig.json"));
  for (const candidate of [specifier, `${specifier}.json`, `${specifier}/tsconfig.json`]) {
    try {
      const resolved = require.resolve(candidate);
      if (resolved.endsWith(".json")) return resolved;
    } catch {
      // The next spelling, as TypeScript tries them.
    }
  }
  return undefined;
}

/** Follows every `extends` of a parsed tsconfig at `fromDir`, depth first.
 * A file already seen on the way counts as read, so a cycle ends. */
export function readExtendsChain(tsconfig: unknown, fromDir: string, seen: Set<string> = new Set()): ExtendsChain {
  const specifiers = extendsSpecifiers(tsconfig);
  if (specifiers === undefined) return { kind: "unread", specifier: JSON.stringify((tsconfig as { extends?: unknown }).extends) };
  for (const specifier of specifiers) {
    const file = resolveExtends(specifier, fromDir);
    if (file === undefined) return { kind: "unread", specifier };
    if (seen.has(file)) continue;
    seen.add(file);
    let base: unknown;
    try {
      base = parseJsonc(readFileSync(file, "utf8"));
    } catch {
      return { kind: "unread", specifier };
    }
    if (namesTsExtensionOption(base)) return { kind: "names-option" };
    const inherited = readExtendsChain(base, path.dirname(file), seen);
    if (inherited.kind !== "lacks-option") return inherited;
  }
  return { kind: "lacks-option" };
}

/** The stderr line for a tsconfig whose compilerOptions come only through
 * `extends`, when no file in the chain is known to name the option. */
export function extendsNotice(chain: Exclude<ExtendsChain, { kind: "names-option" }>): string {
  const why = "tsc refuses the .ts imports nuka scaffold writes unless one of them is set";
  if (chain.kind === "unread") {
    return `tsconfig.json extends ${JSON.stringify(chain.specifier)}, which nuka init could not read, so it did not check whether ${TS_EXTENSION_OPTION} or allowImportingTsExtensions is set; ${why}`;
  }
  return `tsconfig.json has no compilerOptions of its own, and no file it extends sets ${TS_EXTENSION_OPTION} or allowImportingTsExtensions; ${why}, so add "${TS_EXTENSION_OPTION}": true to compilerOptions`;
}

function appendItems(text: string, tokens: readonly Token[], open: number, close: number, quoted: readonly string[]): string {
  const openAt = tokens[open]?.end ?? 0;
  const closeAt = tokens[close]?.start ?? 0;
  const inside = tokens.slice(open + 1, close).filter((token) => token.kind !== "comment");
  if (inside.length === 0) {
    const rest = text.slice(openAt, closeAt).trim() === "" ? closeAt : openAt;
    return `${text.slice(0, openAt)}${quoted.join(", ")}${text.slice(rest)}`;
  }
  const trailing = isPunct(text, inside[inside.length - 1], ",");
  const last = inside[inside.length - (trailing ? 2 : 1)];
  if (last === undefined) throw new Error("tsconfig.json has a list that starts with a comma");
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

/** The indexes in `tokens` of the brackets of the top-level `key` value,
 * which opens with `bracket`. The last `key` wins, as it does for
 * JSON.parse. */
function topLevelSpan(text: string, tokens: readonly Token[], key: string, bracket: "[" | "{"): { open: number; close: number } {
  const indexes = tokens.flatMap((token, index) => (token.kind === "comment" ? [] : [index]));
  const at = (k: number): Token | undefined => tokens[indexes[k] ?? -1];
  let depth = 0;
  let open = -1;
  for (let k = 0; k < indexes.length; k += 1) {
    const token = at(k);
    if (token === undefined) continue;
    if (token.kind === "string" && depth === 1 && isPunct(text, at(k + 1), ":")) {
      if (JSON.parse(text.slice(token.start, token.end)) === key) open = indexes[k + 2] ?? -1;
    }
    if (isPunct(text, token, "{") || isPunct(text, token, "[")) depth += 1;
    if (isPunct(text, token, "}") || isPunct(text, token, "]")) depth -= 1;
  }
  if (!isPunct(text, tokens[open], bracket)) throw new Error(`tsconfig.json has no top-level ${key} value opening with ${bracket}`);
  return { open, close: matchingBracket(text, tokens, open, key) };
}

function stringEnd(text: string, start: number): number {
  let j = start + 1;
  while (j < text.length && text[j] !== '"') {
    j += text[j] === "\\" ? 2 : 1;
  }
  return j + 1;
}

function matchingBracket(text: string, tokens: readonly Token[], open: number, key: string): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (isPunct(text, token, "[") || isPunct(text, token, "{")) depth += 1;
    if (isPunct(text, token, "]") || isPunct(text, token, "}")) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`tsconfig.json's ${key} value is not closed`);
}

/** What `init` did about tsconfig.json: whether it wrote one or both edits,
 * and the stderr line about the option when `extends` alone supplies
 * compilerOptions (see this file's header for each silent case). */
export type TsconfigEditOutcome = { readonly written: boolean; readonly notice?: string };

/** Adds the missing `include` entries and the `.ts` import option to
 * tsconfig.json in place. */
export async function ensureTsconfig(
  rootDir: string,
  featuresDir: string,
  configFileName: string,
): Promise<TsconfigEditOutcome> {
  const tsconfigPath = path.join(rootDir, "tsconfig.json");
  let text: string;
  let parsed: unknown;
  try {
    text = await readFile(tsconfigPath, "utf8");
    parsed = parseJsonc(text);
  } catch {
    return { written: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { written: false };
  let edited = text;
  const include = (parsed as { include?: unknown }).include;
  if (Array.isArray(include) && include.every((entry): entry is string => typeof entry === "string")) {
    edited = appendIncludeEntries(edited, missingIncludeEntries(include, featuresDir, configFileName));
  }
  let notice: string | undefined;
  if (!namesTsExtensionOption(parsed)) {
    const chain = "extends" in parsed ? readExtendsChain(parsed, rootDir, new Set([tsconfigPath])) : undefined;
    if (chain?.kind === "names-option") {
      // A base file made the choice.
    } else if (needsTsExtensionOption(parsed)) {
      edited = appendCompilerOption(edited, TS_EXTENSION_OPTION);
    } else if (chain !== undefined) {
      notice = extendsNotice(chain);
    }
  }
  const written = edited !== text;
  if (written) await writeFile(tsconfigPath, edited);
  return notice === undefined ? { written } : { written, notice };
}

/** A file in the tsconfig chain that could not be read, and why. */
type Unread = { kind: "unread"; file: string; detail: string };

type OptionValue = { kind: "set"; value: unknown } | { kind: "unset" } | Unread;

/** The value TypeScript takes for one compiler option: the file's own
 * `compilerOptions`, else the last `extends` entry that sets it, as a later
 * base overrides an earlier one. */
function effectiveOption(tsconfig: unknown, fromFile: string, key: string, seen: Set<string>): OptionValue {
  const options = ownCompilerOptions(tsconfig);
  if (options !== undefined && key in options) return { kind: "set", value: (options as Record<string, unknown>)[key] };
  const specifiers = extendsSpecifiers(tsconfig);
  if (specifiers === undefined) return { kind: "unread", file: fromFile, detail: "its extends is neither a string nor a list of strings" };
  for (const specifier of [...specifiers].reverse()) {
    const file = resolveExtends(specifier, path.dirname(fromFile));
    if (file === undefined) return { kind: "unread", file: fromFile, detail: `its extends ${JSON.stringify(specifier)} names no file` };
    if (seen.has(file)) continue;
    let base: unknown;
    try {
      base = parseJsonc(readFileSync(file, "utf8"));
    } catch {
      return { kind: "unread", file, detail: "it does not parse as JSON" };
    }
    const inherited = effectiveOption(base, file, key, new Set([...seen, file]));
    if (inherited.kind !== "unset") return inherited;
  }
  return { kind: "unset" };
}

/** Whether the project's `tsc` accepts a relative import that names a `.ts`
 * file. */
export type TsExtensionImports = { kind: "no-tsconfig" } | { kind: "accepted" } | { kind: "refused" } | Unread;

/** Whether tsconfig.json, through its `extends` chain, sets
 * `rewriteRelativeImportExtensions` or `allowImportingTsExtensions` to true.
 * A file in the chain that cannot be read is reported with its path relative
 * to `rootDir`, so a caller that falls back to the `.js` name can say which
 * file made it fall back. */
export function tsExtensionImports(rootDir: string): TsExtensionImports {
  const tsconfigPath = path.join(rootDir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) return { kind: "no-tsconfig" };
  let parsed: unknown;
  try {
    parsed = parseJsonc(readFileSync(tsconfigPath, "utf8"));
  } catch {
    return { kind: "unread", file: "tsconfig.json", detail: "it does not parse as JSON" };
  }
  const options = [TS_EXTENSION_OPTION, "allowImportingTsExtensions"].map((key) =>
    effectiveOption(parsed, tsconfigPath, key, new Set([tsconfigPath])),
  );
  if (options.some((option) => option.kind === "set" && option.value === true)) return { kind: "accepted" };
  const unread = options.find((option): option is Unread => option.kind === "unread");
  if (unread === undefined) return { kind: "refused" };
  return { ...unread, file: path.relative(rootDir, unread.file).split(path.sep).join("/") };
}
