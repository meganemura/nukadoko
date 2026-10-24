import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import { createLineBuffer } from "../sink/line-buffer.js";

// Responsibility: a world's `program.log`, the one file that holds what
// its build, prepare, and serve commands printed, redacted line by line
// as it arrives. Boundary: writing and reading the file; which commands
// run is src/program/world.ts's.
//
// Each stream of each command is split into lines of its own before it is
// written (src/sink/line-buffer.ts), so a secret a chunk boundary cuts in
// two is still one line when it is redacted, and a stdout line and a
// stderr line never splice. A line is written as soon as it is complete,
// so a step that reads the log at its end sees what the program printed
// while the step ran. The file opens at the first line, so a world that
// runs no command leaves no empty log behind.

export interface ProgramLog {
  /** The file's absolute path. */
  readonly path: string;
  /** Whether anything was written. */
  readonly written: boolean;
  /** Appends one line nukadoko writes itself, such as the command about
   * to run. */
  note(line: string): void;
  /** A sink for one stream of one child process. */
  stream(): { push(chunk: Buffer | string): void; flush(): void };
  /** The last `lines` lines written, for a message that says why the
   * program did not start. */
  tail(lines?: number): string;
  close(): void;
}

const DEFAULT_TAIL_LINES = 20;

export function openProgramLog(filePath: string, secrets: SecretSet): ProgramLog {
  let fd: number | undefined;
  let written = false;
  let closed = false;
  const append = (line: string): void => {
    const text = `${redactString(line, secrets)}\n`;
    // A line a stopped program's last child prints after the log closed
    // still belongs in it.
    if (fd === undefined) mkdirSync(path.dirname(filePath), { recursive: true });
    if (closed) {
      appendFileSync(filePath, text);
    } else {
      fd ??= openSync(filePath, "a");
      writeSync(fd, text);
    }
    written = true;
  };
  return {
    path: filePath,
    get written() {
      return written;
    },
    note: append,
    stream() {
      return createLineBuffer(append);
    },
    tail(lines = DEFAULT_TAIL_LINES) {
      if (!written) return "";
      return readFileSync(filePath, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    },
    close() {
      if (fd !== undefined) closeSync(fd);
      fd = undefined;
      closed = true;
    },
  };
}
