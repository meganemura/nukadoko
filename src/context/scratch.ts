import { mkdtempSync } from "node:fs";
import { cp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Scratch } from "../step/context.js";
import { InvalidScratchPrefixError } from "./errors.js";

// Responsibility: the builtin `scratch` fixture (docs/spec.md "Fixtures"),
// whose step-facing type is `Scratch` in src/step/context.ts:
// temporary directories a step can write into freely, and the executor-only
// side that lists them for the step record and removes them when the
// context that handed them out is disposed. Removal belongs here, not in
// the step, because only the executor knows when a scenario has ended,
// whether it passed or failed.
//
// Every project that ran filesystem scenarios used to write this fixture
// for itself in its config, together with a `StepFixtures` module
// augmentation. It needs nothing from a browser or a server, so it is
// built for every executor (`nuka run`, `nuka do`, a live session, and
// `recordStep`) the same way.

const DEFAULT_PREFIX = "nukadoko-scratch";

export interface ScratchCollector {
  readonly scratch: Scratch;
  /** Executor-only: the directories created since the last `reset()`, in
   * creation order. */
  snapshot(): string[];
  /** Executor-only: starts a new step boundary. The directories stay on
   * disk and stay listed for `removeAll()`. */
  reset(): void;
  /** Executor-only: removes every directory this collector ever created.
   * Leaves `snapshot()` as it was, so a step record built after disposal
   * still names where the step worked. Never throws: a directory the step
   * already removed is not an error, and a removal failure must not cost
   * the step record that `dispose()` is still building. */
  removeAll(): Promise<void>;
}

export interface ScratchCollectorOptions {
  /** What a relative `copy(source)` resolves against: the project root. */
  readonly rootDir: string;
  /** The parent of every directory. Defaults to the OS temporary
   * directory; tests pass their own so they can list what is left. */
  readonly tmpRoot?: string;
}

export function createScratchCollector(options: ScratchCollectorOptions): ScratchCollector {
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const all: string[] = [];
  let sinceBoundary: string[] = [];

  function dir(prefix: string = DEFAULT_PREFIX): string {
    if (prefix.includes("/") || prefix.includes("\\")) {
      throw new InvalidScratchPrefixError(prefix);
    }
    const created = mkdtempSync(path.join(tmpRoot, `${prefix === "" ? DEFAULT_PREFIX : prefix}-`));
    all.push(created);
    sinceBoundary.push(created);
    return created;
  }

  async function copy(source: string): Promise<string> {
    const from = path.resolve(options.rootDir, source);
    // Read before the directory is created, so a missing source throws
    // without leaving an empty directory in the step record.
    const isFile = (await stat(from)).isFile();
    const target = dir();
    await cp(from, isFile ? path.join(target, path.basename(from)) : target, { recursive: true });
    return target;
  }

  return {
    scratch: { dir, copy },
    snapshot(): string[] {
      return [...sinceBoundary];
    },
    reset(): void {
      sinceBoundary = [];
    },
    async removeAll(): Promise<void> {
      const pending = all.splice(0);
      await Promise.all(
        pending.map((created) =>
          rm(created, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined),
        ),
      );
    },
  };
}
