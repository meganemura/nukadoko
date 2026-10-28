import { redactString } from "../secrets/redact.js";
import type { SecretSet } from "../secrets/types.js";
import type { WritableSink } from "../sink/writable-sink.js";

// The hold on `process.exit` is taken at the same moment as the output, for
// the same invocations, so it reaches the CLI through this surface.
export { holdProcessExit } from "./project-exit.js";

// Responsibility: keep the process stdout for records only, for a whole
// invocation that runs project code, and keep the secrets a record
// redacts out of what project code prints.
//
// `nuka do` prints one JSON step record on stdout. `nuka run` prints one
// NDJSON scenario record per line. A worker's own stdout is the envelope
// stream the parent parses. Project code shares that `process.stdout`: a
// step body, a hook, a BeforeAll or AfterAll, a fixture, a World
// constructor, a step file while it loads, and a step that keeps running
// after its timeout. A write from any of them lands in the middle of the
// stream, and a parser fails on the first non-JSON line (a write with no
// trailing newline is worse: it glues onto the next record). stderr is
// already where a person watching the run looks, so the text stays
// visible there and the record stream stays parseable.
//
// The diversion is never put back. A step that outlived its timeout can
// still write after the run has printed its last record, and only the
// process exit ends that. Records reach the real stdout through the sink
// this function returns, which keeps the `write` found before the switch.
//
// What project code prints can hold a value the env files loaded, such as
// a token in a logged request, and a record has it redacted. Every write
// to the process stdout or stderr passes through the same redaction once
// the invocation knows its secrets. A secret split across two writes is
// not found; console.log writes each line in one call.

/** A sink on the real stdout. `written` is called once the chunk, and
 * every chunk before it, has reached the stream. */
export interface RecordSink extends WritableSink {
  write(chunk: string, written?: () => void): unknown;
}

export interface ProcessOutput {
  /** The real stdout, for records only. */
  readonly records: RecordSink;
  /** Redacts `secrets` from every later write to the process stdout or
   * stderr, beside the ones given before. */
  readonly redact: (secrets: SecretSet) => void;
}

/** Points `process.stdout.write` at stderr for the rest of the process,
 * passes every write to either through the redaction `redact` adds to,
 * and returns a sink that still writes to the real stdout. */
export function takeOverProcessOutput(): ProcessOutput {
  const recordWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
  let secrets: SecretSet = [];
  const redacted = (chunk: string | Uint8Array): string | Uint8Array => {
    if (secrets.length === 0) return chunk;
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const shown = redactString(text, secrets);
    return shown === text ? chunk : shown;
  };
  const write = ((chunk: string | Uint8Array, ...rest: unknown[]) => stderrWrite(redacted(chunk), ...rest)) as typeof process.stderr.write;
  process.stdout.write = write;
  process.stderr.write = write;
  return {
    records: { write: (chunk: string, written?: () => void) => recordWrite(chunk, written) },
    redact: (more) => {
      secrets = [...secrets, ...more];
    },
  };
}
