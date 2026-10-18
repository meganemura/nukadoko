import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ZodArray, ZodDefault, ZodObject, ZodOptional, ZodRecord, type z } from "zod";
import { ConfigError } from "./errors.js";
import { cjsTsMismatchExplanation, refusesEsmTs } from "./module-kind.js";
import { configSchema, type NukadokoConfig } from "./schema.js";
import { describeImportFailure } from "./import-failure.js";
import { importInNamespace, newNamespace } from "./ts-loader.js";

// The two names loadConfig ever reads, in preference order. Exported so
// `nuka init` can check both for existence before generating anything (a
// stray nukadoko.config.mts must refuse init exactly like a stray
// nukadoko.config.ts already did), and so tests can reason about the set
// without duplicating it.
export const CONFIG_FILE_NAMES = ["nukadoko.config.ts", "nukadoko.config.mts"] as const;

// The name to use when no config file exists yet, and the name `nuka
// scaffold`'s tests reason about — kept as its own export (rather than
// `CONFIG_FILE_NAMES[0]`) since most callers only ever care about "the
// default", not "the full accepted set".
export const CONFIG_FILE_NAME: string = CONFIG_FILE_NAMES[0];

// Responsibility: find a project's config file (nukadoko.config.ts or
// nukadoko.config.mts — CONFIG_FILE_NAMES above) under a project root, load
// it at run time (TypeScript, which Node loads by erasing its types;
// src/config/ts-loader.ts), and turn its default
// export into a fully-defaulted, validated NukadokoConfig. Applying
// defaults through the same schema used for validation (rather than a
// second hard-coded literal) keeps "file absent" and "file present but
// empty" behave identically. Empty means `export default {}`. A file that
// does not default-export the object is not empty: a missing default, or
// a Promise, is a ConfigError naming the file. Reading either as `{}`
// would ignore every key the file stated, including secrets.redact. A
// repeated load of the same root returns the already-parsed config while
// the file is unchanged (`configByRoot`, below): each load is a fresh
// module graph, so a load per call cannot be the implementation.
//
// .mts exists for one reason: a project whose package.json has no
// "type": "module" (CommonJS) reads a plain .ts file's module kind from
// that same package.json field, so a `"type": "commonjs"` project's .ts
// config is read as CommonJS and fails before a single line of it runs,
// and a project with no "type" at all gets Node's reparse warning on
// every load. .mts is
// unambiguous ESM regardless of package.json, which is the one thing that
// lets such a project load a config at all (docs/migration.md "Stage 0:
// install and point nukadoko at your suite"). `nuka init` decides which
// name to write (src/config/module-kind.ts's isCommonJsProject); this
// module only reads whichever one is actually on disk.

/** Strips `ZodOptional`/`ZodDefault` down to the schema they wrap — every
 * container `configSchema` nests a `.strict()` object inside (`environments.
 * <name>`, `secrets`, `parameterTypes[i]`, ...) is reached through one or
 * both of these, so a path walk that didn't see through them would stop one
 * step short. */
function unwrapSchema(schema: unknown): unknown {
  let current = schema;
  while (current instanceof ZodOptional || current instanceof ZodDefault) {
    current = current.unwrap();
  }
  return current;
}

/**
 * Finds the known key set for the `.strict()` object a given
 * `unrecognized_keys` issue's own `path` names, by walking `configSchema`
 * itself one path segment at a time — never the parsed data, which is only
 * available if parsing had otherwise succeeded. A segment steps into a
 * `ZodObject`'s named property (`secrets`, `allure`, ...), a `ZodRecord`'s
 * value schema regardless of the segment's own value (an `environments.
 * <name>` entry, keyed by whatever name a config author chose), or a
 * `ZodArray`'s element schema regardless of the segment's own value (a
 * `parameterTypes[i]` entry) — the three container shapes a nested
 * `.strict()` object can sit inside here. Returns `undefined` when the walk
 * cannot resolve to a `ZodObject` — not expected for a real
 * `unrecognized_keys` issue (that code only ever fires from inside a
 * `.strict()` object), but a suggestion is simply omitted rather than
 * guessed when it happens.
 */
function knownKeysAt(path: readonly PropertyKey[]): readonly string[] | undefined {
  let current: unknown = configSchema;
  for (const segment of path) {
    current = unwrapSchema(current);
    if (current instanceof ZodObject) {
      current = (current.shape as Record<string, unknown>)[String(segment)];
    } else if (current instanceof ZodRecord) {
      current = current.valueType;
    } else if (current instanceof ZodArray) {
      current = current.element;
    } else {
      return undefined;
    }
  }
  current = unwrapSchema(current);
  return current instanceof ZodObject ? Object.keys(current.shape) : undefined;
}

/**
 * Names the one known key an unrecognized key case-insensitively matches,
 * when there is exactly one, and never an edit-distance guess: a check that
 * guesses is worse than no check, because a wrong suggestion teaches the
 * reader to ignore the right ones. A case-insensitive exact
 * match is not a guess: the two strings already agree on every character,
 * only their case differs, so naming the known key states a fact about the
 * schema rather than proposing one candidate among several plausible ones.
 */
function suggestFor(key: string, known: readonly string[] | undefined): string {
  const match = known?.find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return match === undefined ? "" : ` (did you mean "${match}"?)`;
}

// A Promise has no own enumerable keys, so an object schema parses it as
// `{}` and fills every default. That is the same silent drop as a missing
// default export. Any thenable has that shape, so the check is `then`,
// not only `instanceof Promise`.
function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  return typeof (value as { then?: unknown }).then === "function";
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      if (issue.code === "unrecognized_keys") {
        const known = knownKeysAt(issue.path);
        const described = issue.keys.map((key) => `${key}${suggestFor(key, known)}`).join(", ");
        return `unknown key(s): ${described}`;
      }
      const key = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${key}: ${issue.message}`;
    })
    .join("; ");
}

export interface ResolvedConfigFile {
  readonly path: string;
  readonly fileName: string;
}

/**
 * Finds which of CONFIG_FILE_NAMES exists under `rootDir`. Both existing at
 * once is refused outright, as a `ConfigError` naming both absolute paths:
 * loading one over the other silently would mean which config actually
 * governs a run depends on an ordering nothing in the project states, and a
 * project that meant to keep only one now has a second, stale copy nobody
 * is reading. `null` means neither exists — not an error on its own;
 * callers fall back to schema defaults the same way an absent
 * nukadoko.config.ts always has.
 */
function findConfigFile(rootDir: string): ResolvedConfigFile | null {
  const found = CONFIG_FILE_NAMES.map((fileName) => ({
    fileName,
    path: path.join(rootDir, fileName),
  })).filter((candidate) => existsSync(candidate.path));

  if (found.length > 1) {
    const paths = found.map((candidate) => candidate.path).join(" and ");
    throw new ConfigError(
      `Both ${paths} exist; nukadoko cannot tell which one to read. Delete one and keep the other.`,
      found[0]!.path,
      { fix: `Delete ${found[0]!.fileName} or ${found[1]!.fileName}, and keep the one that holds the project's config.` },
    );
  }
  return found[0] ?? null;
}

/**
 * The config file name a project actually resolves to: whichever of
 * CONFIG_FILE_NAMES exists, or CONFIG_FILE_NAME (the default) when neither
 * does. For a caller that needs to name "the config file" in a message
 * (e.g. src/check/analyze.ts attributing a config.fixtures issue to the
 * file it lives in) without also wanting `findConfigFile`'s `null`/both-
 * exist handling spelled out again.
 */
export function resolveConfigFileName(rootDir: string): string {
  return findConfigFile(rootDir)?.fileName ?? CONFIG_FILE_NAME;
}

// Each load is a module graph of its own (src/config/ts-loader.ts), and
// Node never frees a module it loaded. One command reaches loadConfig from
// several modules, and a process that calls runCli again and again (a test
// suite) calls it once per command, so a load per call would
// grow that process by a graph per call. So the parsed result is kept per root, and the load
// happens once for each version of the file. One process can outlive an
// edit to the config (runCli called twice, the MCP server),
// so the kept result is reused only while the same file name exists with
// the same mtime and size; a stat per call costs far less than a load.
// A module the config imports is not part of that check. A failed load is
// dropped, so the next call can see a file that has since been corrected.
const configByRoot = new Map<string, { stamp: string; config: Promise<NukadokoConfig> }>();

export async function loadConfig(rootDir: string): Promise<NukadokoConfig> {
  const key = path.resolve(rootDir);
  const stamp = configFileStamp(key);
  const cached = configByRoot.get(key);
  if (cached !== undefined && cached.stamp === stamp) return cached.config;

  const entry = { stamp, config: readConfig(key) };
  configByRoot.set(key, entry);
  try {
    return await entry.config;
  } catch (error) {
    if (configByRoot.get(key) === entry) configByRoot.delete(key);
    throw error;
  }
}

// Names the config file version a cached result was read from. Each name
// is stat'ed, so both names existing at once still reaches readConfig's
// refusal on the next call.
function configFileStamp(rootDir: string): string {
  return CONFIG_FILE_NAMES.map((fileName) => {
    const stats = statSync(path.join(rootDir, fileName), { throwIfNoEntry: false });
    return stats === undefined ? `${fileName}:-` : `${fileName}:${stats.mtimeMs}:${stats.size}`;
  }).join("|");
}

// A config that cannot find `nukadoko` itself has one fix: the project
// installs the package. Any other missing package may be a typo in the
// import, so it is named, not installed.
function importFailureHint(
  fileName: string,
  missingPackage: { readonly name: string; readonly importedBy?: string } | undefined,
  explanation: string,
): { readonly fix?: string; readonly do?: string } {
  if (missingPackage?.name === "nukadoko" && missingPackage.importedBy === undefined) {
    return { do: "npm install -D -E nukadoko" };
  }
  if (explanation !== "") return { do: renameToMts(fileName) };
  if (missingPackage !== undefined) {
    return { fix: `Install ${missingPackage.name} in the project, or correct the import of it in ${missingPackage.importedBy ?? fileName}.` };
  }
  return { fix: `Correct the error the message names in ${fileName}.` };
}

function renameToMts(configPath: string): string {
  const fileName = path.basename(configPath);
  return `mv ${fileName} ${fileName.replace(/\.ts$/, ".mts")}`;
}

async function readConfig(rootDir: string): Promise<NukadokoConfig> {
  const resolved = findConfigFile(rootDir);
  const configPath = resolved?.path ?? path.join(rootDir, CONFIG_FILE_NAME);

  let raw: unknown = {};
  // Empty unless a config file is present, package.json says "type":
  // "commonjs", and that file is `.ts`. Appended on both failures below,
  // since a CommonJS read can fail at import or come back as an object the
  // schema refuses. Any other file or project gets nothing appended.
  const explanation =
    resolved === null ? "" : cjsTsMismatchExplanation(refusesEsmTs(rootDir), configPath);
  if (resolved !== null) {
    let mod: { default?: unknown };
    try {
      mod = (await importInNamespace(pathToFileURL(configPath).href, newNamespace())) as { default?: unknown };
    } catch (error) {
      // The CLI prints this error's message and nothing else. The raw
      // rejection does not name the config file: a missing export names
      // nukadoko's package.json, and a syntax error names no file at all,
      // so its location is added the way a step file's is.
      const cause = describeImportFailure(error, configPath, rootDir);
      throw new ConfigError(
        `Could not import config at ${configPath}: ${cause.message}${explanation}`,
        configPath,
        importFailureHint(resolved.fileName, cause.missingPackage, explanation),
        { cause: error },
      );
    }
    if (mod.default === undefined) {
      throw new ConfigError(
        `${configPath} has no default export. nukadoko reads the default export as the config.`,
        configPath,
        { fix: `Export the config as the default export of ${resolved.fileName}: export default defineConfig({ ... }).` },
      );
    }
    if (isThenable(mod.default)) {
      throw new ConfigError(
        `${configPath} has a Promise as its default export. Export the config object, not a Promise of it.`,
        configPath,
        { fix: `Export the config object itself as the default export of ${resolved.fileName}, not a Promise of it.` },
      );
    }
    raw = mod.default;
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `Invalid config at ${configPath}: ${formatIssues(result.error.issues)}${explanation}`,
      configPath,
      explanation === ""
        ? { fix: `Correct the fields the message names in ${resolved?.fileName ?? CONFIG_FILE_NAME}.` }
        : { do: renameToMts(configPath) },
    );
  }
  return result.data;
}
