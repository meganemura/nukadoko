// Responsibility: where a step's own code threw, as the project's own
// frames of the thrown error's stack. Boundary: it reads a stack string and
// paths; it never reads a file and never decides the error's kind.
//
// A step record's `error.message` says what went wrong but not where, so a
// reader had to call the step again outside nukadoko to find the line. The
// frames kept are the ones a reader can open and change: inside the project
// root and outside any `node_modules`, which leaves out nukadoko itself,
// Playwright, and Node's own frames. The column is left out so the Ruby
// engine, whose backtrace has none, writes the same shape.

import path from "node:path";
import { fileURLToPath } from "node:url";

/** At most this many frames: the first few are where the step's code was
 * when it threw, and a longer list is the call chain a reader rarely needs. */
export const MAX_ERROR_FRAMES = 5;

const FRAME = /^\s*at (?:.*? \()?(.+?):(\d+):\d+\)?$/;

/** The project's own frames of `thrown`'s stack, each `path:line` relative
 * to `rootDir`, in stack order, without repeats. Empty when `thrown` is not
 * an Error with a stack, or no frame is the project's own. */
export function projectFrames(thrown: unknown, rootDir: string): string[] {
  if (!(thrown instanceof Error) || typeof thrown.stack !== "string") {
    return [];
  }
  const frames: string[] = [];
  for (const line of thrown.stack.split("\n")) {
    const match = FRAME.exec(line);
    if (match === null) {
      continue;
    }
    const [, location = "", lineNumber = ""] = match;
    let file = location;
    if (file.startsWith("file://")) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (!path.isAbsolute(file)) {
      continue;
    }
    const relative = path.relative(rootDir, file);
    if (relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).includes("node_modules")) {
      continue;
    }
    const frame = `${relative.split(path.sep).join("/")}:${lineNumber}`;
    if (!frames.includes(frame)) {
      frames.push(frame);
    }
    if (frames.length === MAX_ERROR_FRAMES) {
      break;
    }
  }
  return frames;
}
