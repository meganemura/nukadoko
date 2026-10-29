import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Responsibility: the file a served world's program appends its execution
// events to, `{events}` (docs/spec.md "Execution events"): making it
// before the world's first command runs, and removing it after the world
// stopped, or when nukadoko exits by any path it can handle. Boundary: no
// line of it is read here; src/context/events-file.ts reads it.
//
// The program writes the file directly, so it holds whatever the program
// wrote, secrets included, until nukadoko reads and redacts it. It lives
// in a directory of its own in the system's temporary directory, made with
// mode 0700, and the file with mode 0600, never in the run directory,
// which CI uploads: a crash, or a job runner that outlives the stop, would
// otherwise leave raw lines where the records are collected. Only the
// redacted copies reach the run directory. The file exists before the
// program starts, so every reader opens the same file, and a reader can
// tell when the program replaced it.

const removedOnExit = new Set<string>();
let exitListenerAdded = false;

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Gone already, or held open on Windows: the system's temporary
    // directory is cleared on its own schedule.
  }
}

export interface EventsInlet {
  /** The absolute path `{events}` fills. */
  readonly path: string;
  /** Removes the file and its directory. */
  remove(): void;
}

export function openEventsInlet(): EventsInlet {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nukadoko-events-"));
  const file = path.join(dir, "events.jsonl");
  writeFileSync(file, "", { mode: 0o600, flag: "wx" });
  removedOnExit.add(dir);
  if (!exitListenerAdded) {
    exitListenerAdded = true;
    process.on("exit", () => {
      for (const listed of removedOnExit) removeDir(listed);
    });
  }
  return {
    path: file,
    remove() {
      removedOnExit.delete(dir);
      removeDir(dir);
    },
  };
}
