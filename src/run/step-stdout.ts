import type { WritableSink } from "../sink/writable-sink.js";

// Responsibility: keep the process stdout for records only, for a whole
// invocation that runs project code.
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

/** Points `process.stdout.write` at stderr for the rest of the process and
 * returns a sink that still writes to the real stdout. */
export function divertProcessStdoutToStderr(): WritableSink {
  const recordWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  return { write: (chunk: string) => recordWrite(chunk), isTTY: process.stdout.isTTY === true };
}
