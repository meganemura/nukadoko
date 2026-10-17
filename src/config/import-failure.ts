import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loaderUrl, withoutNamespace } from "./ts-loader.js";
import { typeOnlyImportSentence } from "./type-only-export.js";

// Responsibility: the text and the line a failed import of a step file or
// of the config is reported with, built from the error Node threw.
// Boundary: reads the error, and for one kind of error asks a child process
// where it is; it decides nothing about severity or grouping
// (src/check/analyze.ts does).
//
// Where the location comes from. Node puts a syntax error's file and line
// at the head of `error.stack` when its own TypeScript stripping refuses
// the file (`file:///…/x.ts:3`, then the source line and a caret). A
// syntax error V8 raises while compiling the module (a redeclared name)
// carries no location in the stack at all; Node prints it only when the
// error goes uncaught. So for that one case a child process imports the
// same file and the location is read from what it prints. The child runs
// nothing: a module graph with a syntax error fails before any module in
// it evaluates.

/** Node's error code for TypeScript that type stripping cannot erase. */
const UNSUPPORTED_TYPESCRIPT_SYNTAX = "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX";

export const STRIP_ONLY_SENTENCE =
  "; Node loads TypeScript by erasing its types, and enum, namespace, and parameter-property syntax has run-time behavior that erasing would lose. " +
  'Rewrite it as plain TypeScript (an enum as an object with "as const", a parameter property as a field assigned in the constructor), ' +
  'and set "erasableSyntaxOnly": true in tsconfig.json so tsc reports the next one';

const LOCATION_HEAD = /^(file:\/\/[^\r\n]*?|\/[^\r\n]*?):(\d+)\r?\n/;

// Node 23.x's stripper reports in its own frame (`  x <message>`, then a
// `,-[line:col]` code frame), and names no file anywhere. Later releases
// report the one-line message with the file at the stack's head. The frame's
// line belongs to the step file exactly when the step file itself fails to
// strip: Node strips a module before it links the module's imports, so a
// step file that strips cleanly reached the error through a module it
// imports, and Node does not say which.
const FRAMED_MESSAGE = /^\s*x (.+?)\r?\n\s*,-\[(\d+):\d+\]/s;
const STRIPPED_EXTENSIONS = new Set([".ts", ".mts"]);

export const FRAMED_ELSEWHERE_SENTENCE =
  "; Node 23 does not name the file this error is in, and this step file strips cleanly, so it is in a module this file imports";

function stripFails(filePath: string): boolean {
  if (!STRIPPED_EXTENSIONS.has(path.extname(filePath))) return false;
  try {
    stripTypeScriptTypes(readFileSync(filePath, "utf8"));
    return false;
  } catch {
    return true;
  }
}
const STRIP_ONLY_REFUSAL = /not supported in strip-only mode/;

/** The file and line at the head of a stack or of Node's uncaught-error
 * output, or `undefined` when it starts with anything else. */
export function headLocation(text: string): { readonly path: string; readonly line: number } | undefined {
  const match = LOCATION_HEAD.exec(withoutNamespace(text));
  if (match === null) return undefined;
  const location = match[1]!;
  return { path: location.startsWith("file://") ? fileURLToPath(location) : location, line: Number(match[2]) };
}

function locateInChild(filePath: string): { readonly path: string; readonly line: number } | undefined {
  const child = spawnSync(
    process.execPath,
    ["--import", loaderUrl, "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(filePath).href)})`],
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 },
  );
  return typeof child.stderr === "string" ? headLocation(child.stderr) : undefined;
}

export interface ImportFailureDetail {
  /** Node's message without the loader's namespace, plus the location when
   * the error has one, plus the strip-only sentence when that is the
   * cause. */
  readonly message: string;
  /** The line in `filePath` itself, when the error names one there. */
  readonly line?: number;
  /** The package `filePath` itself imports and Node could not find, when
   * that is the error. A package missing deeper in the graph is not
   * named: installing it is not known to be the fix there. */
  readonly missingPackage?: string;
}

const MISSING_PACKAGE = /^Cannot find package '((?:@[^/']+\/)?[^/']+)' imported from ([^\r\n]+)/;

/** The package `filePath` itself imports, when `message` is Node's
 * `ERR_MODULE_NOT_FOUND` text for a package it could not find. */
export function missingPackageOf(code: unknown, message: string, filePath: string): string | undefined {
  if (code !== "ERR_MODULE_NOT_FOUND") return undefined;
  const match = MISSING_PACKAGE.exec(message);
  if (match === null) return undefined;
  return path.resolve(match[2]!) === path.resolve(filePath) ? match[1] : undefined;
}

export function describeImportFailure(
  error: unknown,
  filePath: string,
  rootDir: string,
  locate: (filePath: string) => { readonly path: string; readonly line: number } | undefined = locateInChild,
  ownStripFails: (filePath: string) => boolean = stripFails,
): ImportFailureDetail {
  const raw = withoutNamespace(error instanceof Error ? error.message : String(error));
  const framed = FRAMED_MESSAGE.exec(raw);
  const message = framed?.[1] ?? raw;
  const code = (error as { code?: unknown } | null)?.code;
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  const framedLocation =
    framed === null ? undefined : ownStripFails(filePath) ? { path: filePath, line: Number(framed[2]) } : null;
  const location =
    headLocation(stack) ??
    framedLocation ??
    (error instanceof Error && error.name === "SyntaxError" && code === undefined && framed === null
      ? locate(filePath)
      : undefined);
  const sentence =
    (code === UNSUPPORTED_TYPESCRIPT_SYNTAX || (framed !== null && STRIP_ONLY_REFUSAL.test(message)) ? STRIP_ONLY_SENTENCE : "") +
    (framedLocation === null ? FRAMED_ELSEWHERE_SENTENCE : "") +
    typeOnlyImportSentence(message);
  const missingPackage = missingPackageOf(code, message, filePath);
  if (missingPackage !== undefined) return { message: message + sentence, missingPackage };
  if (location === undefined) return { message: message + sentence };
  // In the message even when it is this file: two step files that import
  // one broken module get the same error, and check groups them by text.
  const where = path.relative(rootDir, location.path).split(path.sep).join("/");
  const located = `${message} (${where}:${location.line})${sentence}`;
  return path.resolve(location.path) === path.resolve(filePath)
    ? { message: located, line: location.line }
    : { message: located };
}
