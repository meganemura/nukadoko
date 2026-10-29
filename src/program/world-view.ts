import type { SecretSet } from "../secrets/types.js";

// Responsibility: what the steps of a world see of it, as one plain value
// that crosses to a `--concurrency` worker as JSON: its name, its base
// URL, the env its processes got, the values made for it that every record
// redacts, the prefix of its trace ids, its program log when nukadoko
// serves the program, and the file its program appends execution events
// to when the program file asks for one. Boundary:
// no process; starting and stopping the program is src/program/world.ts's.

export interface WorldView {
  readonly name: string;
  /** The base URL `page`, `context`, `request`, and `pageAs` resolve
   * against; `undefined` for a world with neither `serve` nor `url`. */
  readonly url: string | undefined;
  /** The program file's `env`, placeholders filled, without the
   * variables whose value names `{events}`. The steps' process gets it,
   * so a step and a `runCommand` child read a variable the way the
   * program does; only the program may write the events file. */
  readonly env: Readonly<Record<string, string>>;
  /** `{token}` and anything else made for this world, redacted wherever a
   * record could show it. */
  readonly secrets: SecretSet;
  /** The absolute path of `program.log` while nukadoko serves the program
   * and writes what it prints there; `null` for a world it does not serve,
   * whose program's log nukadoko cannot read. */
  readonly log: string | null;
  /** The world's directory, `{dir}`, absolute: where the program keeps
   * its state. A step's own write there is in its `observed.files`. */
  readonly dir: string;
  /** The eight hexadecimal characters every trace id of the world starts
   * with (src/context/trace-context.ts), so every process that reads the
   * program's log finds the same trace id in a line. */
  readonly tracePrefix: string;
  /** The absolute path of the file the program appends its execution
   * events to, `{events}`, while nukadoko serves the program and the
   * program file names it; `null` otherwise. Only the parent makes and
   * removes the file; every process that runs steps reads it. */
  readonly events: string | null;
}

export function serializeWorldView(view: WorldView): string {
  return JSON.stringify(view);
}

/** Reads what `serializeWorldView` wrote. The parent wrote it a moment
 * ago, so a value that does not read is a bug and throws. */
export function parseWorldView(text: string): WorldView {
  const value = JSON.parse(text) as Partial<WorldView>;
  if (typeof value.name !== "string" || typeof value.env !== "object" || !Array.isArray(value.secrets) || typeof value.tracePrefix !== "string" || typeof value.dir !== "string") {
    throw new Error(`not a world view: ${text.slice(0, 200)}`);
  }
  return {
    name: value.name,
    url: value.url ?? undefined,
    env: value.env ?? {},
    secrets: value.secrets,
    log: value.log ?? null,
    dir: value.dir,
    tracePrefix: value.tracePrefix,
    events: typeof value.events === "string" ? value.events : null,
  };
}

/** Sets the world's env on this process, for the steps and every child
 * they start, and returns what puts the previous values back after the
 * world's pass. */
export function applyWorldEnv(env: Readonly<Record<string, string>>): () => void {
  const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
