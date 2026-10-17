import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loaderUrl, withoutNamespace } from "./ts-loader.js";

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
// `,-[line:col]` code frame) under ERR_INVALID_TYPESCRIPT_SYNTAX, for
// erasure failures too, and names no file anywhere, so only the message
// line is kept and no location is claimed. Later releases report the
// one-line message with the file at the stack's head.
const FRAMED_MESSAGE = /^\s*x (.+?)\r?\n\s*,-\[\d+:\d+\]/s;
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
}

export function describeImportFailure(
  error: unknown,
  filePath: string,
  rootDir: string,
  locate: (filePath: string) => { readonly path: string; readonly line: number } | undefined = locateInChild,
): ImportFailureDetail {
  const raw = withoutNamespace(error instanceof Error ? error.message : String(error));
  const message = FRAMED_MESSAGE.exec(raw)?.[1] ?? raw;
  const code = (error as { code?: unknown } | null)?.code;
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  const location =
    headLocation(stack) ??
    (error instanceof Error && error.name === "SyntaxError" && code === undefined ? locate(filePath) : undefined);
  const sentence =
    code === UNSUPPORTED_TYPESCRIPT_SYNTAX || (message !== raw && STRIP_ONLY_REFUSAL.test(message)) ? STRIP_ONLY_SENTENCE : "";
  if (location === undefined) return { message: message + sentence };
  // In the message even when it is this file: two step files that import
  // one broken module get the same error, and check groups them by text.
  const where = path.relative(rootDir, location.path).split(path.sep).join("/");
  const located = `${message} (${where}:${location.line})${sentence}`;
  return path.resolve(location.path) === path.resolve(filePath)
    ? { message: located, line: location.line }
    : { message: located };
}
