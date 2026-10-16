import { readFile } from "node:fs/promises";
import path from "node:path";

// Responsibility: the one-line hint `nuka init` prints when the project's
// own tsconfig.json `include` leaves out the steps directory or the config
// file, so the project's type check never sees the step files. Reads
// tsconfig.json and nothing else; writes nothing, since a tsconfig is the
// project's own file and an edit to it is the project's decision.
//
// The hint is only ever a claim that can end one way: an `include` entry
// with a wildcard in it counts as covering, a tsconfig with no `include` of
// its own (TypeScript's default, or one inherited through `extends`) gets
// no hint, and a file that does not parse gets none either. A false hint
// would teach people to ignore the true ones.

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
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
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
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
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

/** The hint line, without a trailing newline, or `null` when there is
 * nothing to say (see this file's header for each silent case). */
export async function tsconfigIncludeHint(
  rootDir: string,
  featuresDir: string,
  configFileName: string,
): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = parseJsonc(await readFile(path.join(rootDir, "tsconfig.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const include = (parsed as { include?: unknown }).include;
  if (!Array.isArray(include) || !include.every((entry): entry is string => typeof entry === "string")) {
    return null;
  }
  const missing = missingIncludeEntries(include, featuresDir, configFileName);
  if (missing.length === 0) return null;
  const quoted = missing.map((entry) => JSON.stringify(entry)).join(" and ");
  return `tsconfig.json's include leaves out ${missing.length === 1 ? "this path" : "these paths"}, so tsc does not check them; add ${quoted} to it`;
}
