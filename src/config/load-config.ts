import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { ZodArray, ZodDefault, ZodObject, ZodOptional, ZodRecord, type z } from "zod";
import { ConfigError } from "./errors.js";
import { configSchema, type NukadokoConfig } from "./schema.js";

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
// it at run time (it is TypeScript, not something Node can import
// unassisted — hence tsx's tsImport, per the spec), and turn its default
// export into a fully-defaulted, validated NukadokoConfig. Applying
// defaults through the same schema used for validation (rather than a
// second hard-coded literal) keeps "file absent" and "file present but
// empty" behave identically.
//
// .mts exists for one reason: a project whose package.json has no
// "type": "module" (CommonJS) cannot load nukadoko.config.ts at all — tsx
// reads a plain .ts file's module kind from that same package.json field,
// the same rule Node itself applies, so a CommonJS project's .ts config
// is read as CommonJS and fails before a single line of it runs. .mts is
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
 * when there is exactly one — never an edit-distance guess (CLAUDE.md: "a
 * check that guesses is worse than no check"). A case-insensitive exact
 * match is not a guess: the two strings already agree on every character,
 * only their case differs, so naming the known key states a fact about the
 * schema rather than proposing one candidate among several plausible ones.
 */
function suggestFor(key: string, known: readonly string[] | undefined): string {
  const match = known?.find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return match === undefined ? "" : ` (did you mean "${match}"?)`;
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
export function findConfigFile(rootDir: string): ResolvedConfigFile | null {
  const found = CONFIG_FILE_NAMES.map((fileName) => ({
    fileName,
    path: path.join(rootDir, fileName),
  })).filter((candidate) => existsSync(candidate.path));

  if (found.length > 1) {
    const paths = found.map((candidate) => candidate.path).join(" and ");
    throw new ConfigError(
      `Both ${paths} exist; nukadoko cannot tell which one to read. Delete one and keep the other.`,
      found[0]!.path,
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

export async function loadConfig(rootDir: string): Promise<NukadokoConfig> {
  const resolved = findConfigFile(rootDir);
  const configPath = resolved?.path ?? path.join(rootDir, CONFIG_FILE_NAME);

  let raw: unknown = {};
  if (resolved !== null) {
    const mod: { default?: unknown } = await tsImport(
      pathToFileURL(configPath).href,
      import.meta.url,
    );
    raw = mod.default ?? {};
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `Invalid config at ${configPath}: ${formatIssues(result.error.issues)}`,
      configPath,
    );
  }
  return result.data;
}
