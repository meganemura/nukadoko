import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError } from "./errors.js";
import { describeImportFailure } from "./import-failure.js";
import { formatIssues, importFailureHint, isThenable } from "./load-config.js";
import { cjsTsMismatchExplanation, refusesEsmTs } from "./module-kind.js";
import { programSchema, type Program } from "./program-schema.js";
import { importInNamespace, newNamespace } from "./ts-loader.js";

// Responsibility: find a tree's nukadoko.program.ts (or .mts, for the
// same CommonJS reason src/config/load-config.ts accepts
// nukadoko.config.mts), load it, and validate its default export against
// src/config/program-schema.ts. Boundary: reading the file. Layering an
// environment is src/environment/resolve-environment.ts's job, and running
// the recipe is src/program/world.ts's.
//
// A tree without the file has no program: `null`, and a run starts no
// world, which is what a CLI tool whose steps run commands needs. The file
// is read from the tree being built, not from the project the criteria
// come from, so a tree builds with its own recipe.

export const PROGRAM_FILE_NAMES = ["nukadoko.program.ts", "nukadoko.program.mts"] as const;

/** The name a message uses when no program file exists yet. */
export const PROGRAM_FILE_NAME: string = PROGRAM_FILE_NAMES[0];

export interface LoadedProgram {
  readonly program: Program;
  /** The file's name under the tree's root, for messages. */
  readonly fileName: string;
}

function findProgramFile(rootDir: string): { fileName: string; path: string } | null {
  const found = PROGRAM_FILE_NAMES.map((fileName) => ({ fileName, path: path.join(rootDir, fileName) })).filter((candidate) =>
    existsSync(candidate.path),
  );
  if (found.length > 1) {
    throw new ConfigError(
      `Both ${found.map((candidate) => candidate.path).join(" and ")} exist; nukadoko cannot tell which one to read. Delete one and keep the other.`,
      found[0]!.path,
      { fix: `Delete ${found[0]!.fileName} or ${found[1]!.fileName}, and keep the one that holds the program.` },
    );
  }
  return found[0] ?? null;
}

/** The program file's name in `rootDir`: the one that exists, or the
 * default. */
export function resolveProgramFileName(rootDir: string): string {
  return findProgramFile(rootDir)?.fileName ?? PROGRAM_FILE_NAME;
}

// One load per version of the file, for the reason src/config/load-config.ts
// keeps its parsed config: each load is a module graph Node never frees,
// and one command reaches the program from several modules.
const programByRoot = new Map<string, { stamp: string; program: Promise<LoadedProgram | null> }>();

function programFileStamp(rootDir: string): string {
  return PROGRAM_FILE_NAMES.map((fileName) => {
    const stats = statSync(path.join(rootDir, fileName), { throwIfNoEntry: false });
    return stats === undefined ? `${fileName}:-` : `${fileName}:${stats.mtimeMs}:${stats.size}`;
  }).join("|");
}

/** The program of the tree at `rootDir`, or `null` when it has no program
 * file. Throws a ConfigError naming the file when it cannot be read. */
export async function loadProgram(rootDir: string): Promise<LoadedProgram | null> {
  const key = path.resolve(rootDir);
  const stamp = programFileStamp(key);
  const cached = programByRoot.get(key);
  if (cached !== undefined && cached.stamp === stamp) return cached.program;
  const entry = { stamp, program: readProgram(key) };
  programByRoot.set(key, entry);
  try {
    return await entry.program;
  } catch (error) {
    if (programByRoot.get(key) === entry) programByRoot.delete(key);
    throw error;
  }
}

async function readProgram(rootDir: string): Promise<LoadedProgram | null> {
  const found = findProgramFile(rootDir);
  if (found === null) return null;
  const explanation = cjsTsMismatchExplanation(refusesEsmTs(rootDir), found.path);
  let mod: { default?: unknown };
  try {
    mod = (await importInNamespace(pathToFileURL(found.path).href, newNamespace())) as { default?: unknown };
  } catch (error) {
    const cause = describeImportFailure(error, found.path, rootDir);
    throw new ConfigError(
      `Could not import the program file at ${found.path}: ${cause.message}${explanation}`,
      found.path,
      importFailureHint(found.fileName, cause.missingPackage, explanation),
      { cause: error },
    );
  }
  if (mod.default === undefined || isThenable(mod.default)) {
    throw new ConfigError(
      `${found.path} has ${mod.default === undefined ? "no default export" : "a Promise as its default export"}. nukadoko reads the default export as the program.`,
      found.path,
      { fix: `Export the program as the default export of ${found.fileName}: export default defineProgram({ ... }).` },
    );
  }
  const result = programSchema.safeParse(mod.default);
  if (!result.success) {
    throw new ConfigError(`Invalid program at ${found.path}: ${formatIssues(result.error.issues, programSchema)}${explanation}`, found.path, {
      fix: `Correct the fields the message names in ${found.fileName}.`,
    });
  }
  return { program: result.data, fileName: found.fileName };
}
