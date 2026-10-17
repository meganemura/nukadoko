import { versioned } from "../record/schema-version.js";
import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: the one shape every command uses when it stops without
// a report: a config it cannot load, a target that does not exist, a flag
// it refuses. A reader that asked for `--json` gets JSON on stdout even
// then, and every reader gets the one command to run next, so neither has
// to parse stderr prose to recover. A finding, a failed scenario, or a
// failed step is a report, not a refusal, and does not come through here.

export interface Refusal {
  readonly error: string;
  readonly do: string;
}

export interface RefusalSinks {
  readonly json: boolean;
  readonly stdout: WritableSink;
  readonly stderr: WritableSink;
}

/** An error that already knows the next command, so a refusal built from it
 * names that command instead of the fallback. */
export class RefusalError extends Error {
  readonly do: string;

  constructor(message: string, next: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RefusalError";
    this.do = next;
  }
}

/**
 * `fallbackDo` is used unless the error carries its own non-empty `do`.
 * The check is on the property, not on RefusalError, so an error class that
 * lives below the CLI (a discovery or config error) can name its own next
 * command without importing this module.
 */
export function refusalOf(error: unknown, fallbackDo: string): Refusal {
  const message = error instanceof Error ? error.message : String(error);
  const own = typeof error === "object" && error !== null ? (error as { do?: unknown }).do : undefined;
  return { error: message, do: typeof own === "string" && own.length > 0 ? own : fallbackDo };
}

/** What each stream receives. `--json` writes one JSON object on one line to
 * stdout and nothing to stderr, with `schema_version` first like every other
 * document, so a reader that checks the number before the shape reads a
 * refusal the same way; text keeps the message a person has always seen,
 * followed by a `do:` line. */
export function formatRefusal(refusal: Refusal, json: boolean): { stdout: string; stderr: string } {
  if (json) {
    return { stdout: `${JSON.stringify(versioned("refusal", { error: refusal.error, do: refusal.do }))}\n`, stderr: "" };
  }
  return { stdout: "", stderr: `${refusal.error}\ndo: ${refusal.do}\n` };
}

/** A refusal exits 1, the same code as a red report, for now. */
export const REFUSED_EXIT_CODE = 1;
/** Exit 1, for a command that started and then failed while it ran. */
export const FAILED_EXIT_CODE = 1;

/** Writes the refusal and returns the exit code the command returns. */
export function refuse(sinks: RefusalSinks, error: unknown, fallbackDo: string): number {
  writeRefusal(sinks, refusalOf(error, fallbackDo));
  return REFUSED_EXIT_CODE;
}

/** The same shape as `refuse`, for a command that had started: a session
 * file that could not be removed is not the invocation's fault, so it
 * exits 1. */
export function failInShape(sinks: RefusalSinks, error: unknown, fallbackDo: string): number {
  writeRefusal(sinks, refusalOf(error, fallbackDo));
  return FAILED_EXIT_CODE;
}

function writeRefusal(sinks: RefusalSinks, refusal: Refusal): void {
  const written = formatRefusal(refusal, sinks.json);
  if (written.stdout !== "") sinks.stdout.write(written.stdout);
  if (written.stderr !== "") sinks.stderr.write(written.stderr);
}

/**
 * The command an argv names, as far as `commands` (top-level name to its
 * subcommand names) knows it: `["session", "start", "x"]` is `"session
 * start"`, an unknown or missing first word is `""`. A yargs failure has no
 * parsed command to ask, so this reads argv the way a person typed it.
 */
export function commandPathOf(argv: readonly string[], commands: ReadonlyMap<string, readonly string[]>): string {
  const words = argv.filter((word) => !word.startsWith("-"));
  const top = words[0];
  if (top === undefined || !commands.has(top)) return "";
  const sub = words[1];
  return sub !== undefined && commands.get(top)!.includes(sub) ? `${top} ${sub}` : top;
}

/** The fallback `do` for a command: its own help. */
export function helpFor(command: string): string {
  return command === "" ? "nuka --help" : `nuka ${command} --help`;
}
