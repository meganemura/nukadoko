import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError } from "./errors.js";
import { describeImportFailure } from "./import-failure.js";
import { formatIssues, importFailureHint, isThenable, loadConfig, resolveConfigFileName } from "./load-config.js";
import { cjsTsMismatchExplanation, refusesEsmTs } from "./module-kind.js";
import { programSchema, type Program } from "./program-schema.js";
import { importInNamespace, newNamespace } from "./ts-loader.js";

// Responsibility: a tree's program under test, from the `program` function
// of its nukadoko.config.ts, validated against src/config/program-schema.ts.
// Boundary: reading it. Layering an environment is
// src/environment/resolve-environment.ts's job, and running the recipe is
// src/program/world.ts's.
//
// A config with no `program` has no program: `null`, and a run starts no
// world, which is what a CLI tool whose steps run commands needs.
//
// The program goes with the code, and the criteria with the config, so a
// `nuka run --base` tree can hold one side's config and the other side's
// program (src/run/base-run.ts). That tree gets the program's source as a
// file of its own, written by the run beside the tree's config: the other
// side's config as `nukadoko.tree-program.ts`, or, for a ref from before the
// program moved into the config, that ref's program file as
// `nukadoko.tree-legacy-program.ts`. A project's own program file is
// refused, with the move to make.

/** The program file of releases before 0.27, which a project root may no
 * longer hold. */
export const LEGACY_PROGRAM_FILE_NAMES = ["nukadoko.program.ts", "nukadoko.program.mts"] as const;

/** The files a `--base` run writes into a tree for its program: another
 * config whose `program` the tree runs, or a legacy program file. Each
 * keeps the extension of the file it copies. */
export const TREE_PROGRAM_FILE_NAMES = ["nukadoko.tree-program.ts", "nukadoko.tree-program.mts"] as const;
export const TREE_LEGACY_PROGRAM_FILE_NAMES = ["nukadoko.tree-legacy-program.ts", "nukadoko.tree-legacy-program.mts"] as const;

const UPGRADING = 'CHANGELOG.md, under "The program moves into the config"';

export interface LoadedProgram {
  readonly program: Program;
  /** The name of the file under the tree's root that holds it, for
   * messages. */
  readonly fileName: string;
}

function existing(rootDir: string, names: readonly string[]): { fileName: string; path: string } | null {
  for (const fileName of names) {
    const candidate = path.join(rootDir, fileName);
    if (existsSync(candidate)) return { fileName, path: candidate };
  }
  return null;
}

/** The legacy program file in `rootDir`, or `null`. */
export function legacyProgramFile(rootDir: string): { fileName: string; path: string } | null {
  return existing(rootDir, LEGACY_PROGRAM_FILE_NAMES);
}

/** The refusal for a project that still holds a program file of its own:
 * reading it as before would leave the config's `program` and the file to
 * disagree, and ignoring it would start no program where one was written. */
export function legacyProgramError(rootDir: string, found: { fileName: string; path: string }): ConfigError {
  const config = resolveConfigFileName(rootDir);
  return new ConfigError(
    `${found.fileName} is no longer read: the program under test is part of ${config} now, so nukadoko does not start what ${found.fileName} describes.`,
    found.path,
    {
      fix: `Move what ${found.fileName} describes into ${config} as its program, and delete ${found.fileName}; ${UPGRADING}, shows the move.`,
    },
    { code: "program-file-moved" },
  );
}

// One load per version of the files, for the reason src/config/load-config.ts
// keeps its parsed config: each load is a module graph Node never frees,
// and one command reaches the program from several modules.
const programByRoot = new Map<string, { stamp: string; program: Promise<LoadedProgram | null> }>();

function stampOf(rootDir: string): string {
  return [...LEGACY_PROGRAM_FILE_NAMES, ...TREE_PROGRAM_FILE_NAMES, ...TREE_LEGACY_PROGRAM_FILE_NAMES, "nukadoko.config.ts", "nukadoko.config.mts"]
    .map((fileName) => {
      const stats = statSync(path.join(rootDir, fileName), { throwIfNoEntry: false });
      return stats === undefined ? `${fileName}:-` : `${fileName}:${stats.mtimeMs}:${stats.size}`;
    })
    .join("|");
}

/** The program of the tree at `rootDir`, or `null` when it has none.
 * Throws a ConfigError naming the file when it cannot be read, and when
 * the root holds a program file of its own. */
export async function loadProgram(rootDir: string): Promise<LoadedProgram | null> {
  const key = path.resolve(rootDir);
  const stamp = stampOf(key);
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
  const legacyCopy = existing(rootDir, TREE_LEGACY_PROGRAM_FILE_NAMES);
  if (legacyCopy !== null) return { program: validated(await defaultExport(legacyCopy, rootDir), legacyCopy.fileName, legacyCopy.path), fileName: legacyCopy.fileName };
  const treeCopy = existing(rootDir, TREE_PROGRAM_FILE_NAMES);
  if (treeCopy !== null) {
    const config = await defaultExport(treeCopy, rootDir);
    const program = config !== null && typeof config === "object" ? (config as { program?: unknown }).program : undefined;
    return program === undefined ? null : { program: called(program, treeCopy.fileName, treeCopy.path), fileName: treeCopy.fileName };
  }
  const legacy = legacyProgramFile(rootDir);
  if (legacy !== null) throw legacyProgramError(rootDir, legacy);
  const config = await loadConfig(rootDir);
  if (config.program === undefined) return null;
  const fileName = resolveConfigFileName(rootDir);
  return { program: called(config.program, fileName, path.join(rootDir, fileName)), fileName };
}

async function defaultExport(found: { fileName: string; path: string }, rootDir: string): Promise<unknown> {
  const explanation = cjsTsMismatchExplanation(refusesEsmTs(rootDir), found.path);
  let mod: { default?: unknown };
  try {
    mod = (await importInNamespace(pathToFileURL(found.path).href, newNamespace())) as { default?: unknown };
  } catch (error) {
    const cause = describeImportFailure(error, found.path, rootDir);
    throw new ConfigError(
      `Could not import ${found.fileName}: ${cause.message}${explanation}`,
      found.path,
      importFailureHint(found.fileName, cause.missingPackage, explanation),
      { cause: error },
    );
  }
  if (mod.default === undefined || isThenable(mod.default)) {
    throw new ConfigError(`${found.fileName} has ${mod.default === undefined ? "no default export" : "a Promise as its default export"}.`, found.path, {
      fix: `Export the config as the default export of ${found.fileName}.`,
    });
  }
  return mod.default;
}

/** What the config's `program` returns, validated. */
function called(program: unknown, fileName: string, filePath: string): Program {
  if (typeof program !== "function") {
    throw new ConfigError(`Invalid config at ${fileName}: program: must be a function that returns the program`, filePath, {
      fix: `Write program in ${fileName} as program: () => ({ ... }).`,
    });
  }
  let value: unknown;
  try {
    value = (program as () => unknown)();
  } catch (error) {
    throw new ConfigError(`The program function of ${fileName} threw: ${error instanceof Error ? error.message : String(error)}`, filePath, {
      fix: `Make program in ${fileName} return the program object without throwing.`,
    }, { cause: error });
  }
  if (isThenable(value)) {
    throw new ConfigError(`The program function of ${fileName} returned a Promise. nukadoko reads the object it returns as the program.`, filePath, {
      fix: `Return the program object itself from program in ${fileName}, not a Promise.`,
    });
  }
  return validated(value, fileName, filePath, "program.");
}

function validated(value: unknown, fileName: string, filePath: string, prefix = ""): Program {
  const result = programSchema.safeParse(value);
  if (!result.success) {
    // Messages name the file from the project root, where it is found, as
    // every path nukadoko prints does; the absolute path stays on the error.
    const issues = formatIssues(result.error.issues, programSchema);
    throw new ConfigError(`Invalid program at ${fileName}: ${prefix === "" ? issues : issues.replace(/(^|; )(?!unknown key)/g, `$1${prefix}`)}`, filePath, {
      fix: `Correct the fields the message names in ${fileName}.`,
    });
  }
  return result.data;
}

/** The name of the file that holds a tree's program, for a message that
 * says where to write one: the config file. */
export function programFileName(rootDir: string): string {
  return resolveConfigFileName(rootDir);
}

/** A program file of a release before the program moved into the config,
 * which a `--base` ref may still hold: its default export, validated. */
export async function loadLegacyProgram(filePath: string): Promise<Program> {
  const found = { fileName: path.basename(filePath), path: filePath };
  return validated(await defaultExport(found, path.dirname(filePath)), found.fileName, found.path);
}
