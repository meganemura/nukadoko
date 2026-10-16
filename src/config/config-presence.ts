import { existsSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE_NAMES } from "./load-config.js";
import { configSchema } from "./schema.js";

// Responsibility: say whether the directory a command runs in has a config
// file, and when it has none, whether one sits in a parent directory. It
// only names the fact. Reading a parent's config instead, the way git and
// npm walk up, was considered and refused: a command would then answer for
// a project other than the directory it was run in, and every root-relative
// path it prints would point somewhere the reader did not expect.

export type ConfigPresence =
  | { readonly kind: "here" }
  | { readonly kind: "absent" }
  | { readonly kind: "parent"; readonly configPath: string };

/**
 * The walk stops at the first directory holding a `.git` entry, after
 * checking that directory, or at the filesystem root. A config above the
 * repository belongs to some other project. `exists` is injectable so the
 * walk can be tested over generated trees without touching the disk.
 */
export function locateConfig(
  rootDir: string,
  exists: (filePath: string) => boolean = existsSync,
): ConfigPresence {
  const configIn = (dir: string): string | undefined =>
    CONFIG_FILE_NAMES.map((fileName) => path.join(dir, fileName)).find(exists);

  let dir = path.resolve(rootDir);
  if (configIn(dir) !== undefined) return { kind: "here" };
  while (!exists(path.join(dir, ".git"))) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const found = configIn(dir);
    if (found !== undefined) return { kind: "parent", configPath: found };
  }
  return { kind: "absent" };
}

function missingHere(rootDir: string): string {
  return `no ${CONFIG_FILE_NAMES.join(" or ")} in ${path.resolve(rootDir)}`;
}

function relativeTo(rootDir: string, configPath: string): string {
  return path.relative(path.resolve(rootDir), configPath).split(path.sep).join("/");
}

/** The stderr line for a command run without a config, or null when the
 * directory has one. */
export function noConfigLine(rootDir: string, presence: ConfigPresence): string | null {
  if (presence.kind === "here") return null;
  const defaults = `nukadoko's defaults apply (featuresDir "${configSchema.parse({}).featuresDir}")`;
  const line = `${missingHere(rootDir)}; ${defaults}`;
  if (presence.kind === "absent") return line;
  return `${line}; one exists at ${relativeTo(rootDir, presence.configPath)}: run nuka from that directory`;
}

/** Why `nuka scaffold` will not write here, or null when it may. A step
 * file written above the project's config is one that config never reads. */
export function scaffoldParentRefusal(rootDir: string, presence: ConfigPresence): string | null {
  if (presence.kind !== "parent") return null;
  return (
    `${missingHere(rootDir)}, and one exists at ${relativeTo(rootDir, presence.configPath)}; ` +
    "a step file written here is not one that config reads. Run nuka scaffold from that directory"
  );
}
