import path from "node:path";
import { fileURLToPath } from "node:url";

// Responsibility: one sentence for a step file that failed to import because
// a relative `.js`, `.mjs`, or `.cjs` import names a file that is not there.
// A TypeScript project writes `./run-greet.js` for `run-greet.ts` (the
// scaffold does too), and the loader maps the one to the other. When the
// `.ts` file is renamed or deleted, Node's own text names the `.js` path,
// absolute, which never existed, and says nothing of the `.ts` file or of
// which file to edit. The mapping is the loader's rule, not a guess, so the
// file it stood for is exact. This module only reads Node's message and asks
// whether one path exists; the caller keeps Node's text and appends this.
//
// Nothing is appended when the source file does exist, because then the
// cause is something else, or when the path is inside `node_modules`,
// because a package's own file is not one the project edits.

const MODULE_NOT_FOUND = /Cannot find module '([^'\r\n]+)' imported from ([^\r\n]+)/;

/** The loader's own substitution: what a JavaScript extension in an import
 * stands for in a TypeScript project. */
const SOURCE_EXTENSION: Readonly<Record<string, string>> = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts" };

function toPath(location: string): string {
  return location.startsWith("file://") ? fileURLToPath(location) : location;
}

function rootRelative(rootDir: string, file: string): string {
  return path.relative(rootDir, path.resolve(rootDir, file)).split(path.sep).join("/");
}

export function missingTsSourceSentence(
  message: string,
  rootDir: string,
  exists: (absolutePath: string) => boolean,
): string {
  const match = MODULE_NOT_FOUND.exec(message);
  if (match === null) {
    return "";
  }
  const missing = path.resolve(rootDir, toPath(match[1]!));
  const importer = toPath(match[2]!.trim());
  const extension = path.extname(missing);
  const sourceExtension = SOURCE_EXTENSION[extension];
  if (sourceExtension === undefined || missing.split(path.sep).includes("node_modules")) {
    return "";
  }
  const source = missing.slice(0, -extension.length) + sourceExtension;
  if (exists(source)) {
    return "";
  }
  return `; ${rootRelative(rootDir, missing)} stands for ${rootRelative(rootDir, source)}, which does not exist; update the import in ${rootRelative(rootDir, importer)}`;
}
