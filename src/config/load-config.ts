import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { ZodArray, ZodDefault, ZodObject, ZodOptional, ZodRecord, type z } from "zod";
import { ConfigError } from "./errors.js";
import { configSchema, type NukadokoConfig } from "./schema.js";

// Exported (not just module-private) so `nuka init` can check for this
// exact file's existence before generating anything, and `nuka scaffold`'s
// tests can reason about it, without either duplicating the literal.
export const CONFIG_FILE_NAME = "nukadoko.config.ts";

// Responsibility: find nukadoko.config.ts under a project root, load it at
// run time (it is TypeScript, not something Node can import unassisted —
// hence tsx's tsImport, per the spec), and turn its default export into a
// fully-defaulted, validated NukadokoConfig. Applying defaults through the
// same schema used for validation (rather than a second hard-coded literal)
// keeps "file absent" and "file present but empty" behave identically.

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

export async function loadConfig(rootDir: string): Promise<NukadokoConfig> {
  const configPath = path.join(rootDir, CONFIG_FILE_NAME);

  let raw: unknown = {};
  if (existsSync(configPath)) {
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
