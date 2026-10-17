import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TendIssue } from "./types.js";

// Responsibility: the note for a package.json with no "type" field that
// governs a .ts or .js file nukadoko loads (the config or a step file).
// Node reads such a file as CommonJS first, and when it finds ES module
// syntax it parses the file again and prints a MODULE_TYPELESS_PACKAGE_JSON
// warning, on every load. Every nukadoko step file is an ES module, so the
// warning comes back on every run. A note rather than a `nuka check`
// finding: the run works, only slower and noisier.
//
// The governing package.json is the one Node itself uses, the nearest one
// above the file. A file with no package.json above it gets no warning from
// Node, and a package.json that does not parse is Node's own load error, so
// neither gets a note. `.mts` and `.mjs` are always ES modules, so Node
// does not detect anything for them.

const DETECTED_EXTENSIONS = new Set([".ts", ".js"]);

function nearestPackageJson(file: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function hasNoType(packageJsonPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && !("type" in parsed);
  } catch {
    return false;
  }
}

/** One note per package.json with no "type" that governs any of `files`
 * (root-relative paths of the files nukadoko loads). */
export function findTypelessPackageJsons(rootDir: string, files: readonly string[]): TendIssue[] {
  const governed = new Map<string, number>();
  for (const file of files) {
    if (!DETECTED_EXTENSIONS.has(path.extname(file))) continue;
    const packageJson = nearestPackageJson(path.resolve(rootDir, file));
    if (packageJson === undefined || !hasNoType(packageJson)) continue;
    governed.set(packageJson, (governed.get(packageJson) ?? 0) + 1);
  }
  return [...governed].map(([packageJson, count]) => {
    const relative = path.relative(rootDir, packageJson).split(path.sep).join("/");
    const [files, each] = count === 1 ? ["1 .ts or .js file", "it"] : [`${count} .ts or .js files`, "each one"];
    return {
      code: "package-type-missing",
      message: `${relative} has no "type" field, and it governs ${files} nukadoko loads, so Node parses ${each} twice and prints a MODULE_TYPELESS_PACKAGE_JSON warning on every load`,
      file: relative,
      do: `Add "type": "module" to ${relative}, or rename ${count === 1 ? "that file" : "those files"} to .mts if the project's own .js files are CommonJS.`,
    };
  });
}
