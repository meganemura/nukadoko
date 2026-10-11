// Responsibility: while one step function runs, send what it writes to
// the process stdout over to stderr, then put the previous write back.
//
// `nuka do` prints one JSON step record on stdout. `nuka run` prints one
// NDJSON scenario record per line. A worker's own stdout is the envelope
// stream the parent parses. Those writers and the step share
// `process.stdout`. A `console.log` or `process.stdout.write` in the step
// lands in the middle of that stream, and a parser fails on the first
// non-JSON line (a write with no trailing newline is worse: it glues onto
// the next record). stderr is already where a person watching the run
// looks, so the text stays visible there and the record stream stays
// parseable.
//
// The previous `write` is restored when this function settles, including
// when the step throws or the wait around it loses to a timeout, and
// before the caller writes the record. The caller looks `write` up at
// that later moment, so the record reaches the original stdout. A nested
// call saves whatever `write` it found and restores that, so a part
// running inside an already-diverted step does not point stdout back at
// the record stream early.

/** Runs `fn` with `process.stdout.write` aimed at stderr. */
export async function withStepStdoutOnStderr<T>(fn: () => T | Promise<T>): Promise<T> {
  const previousWrite = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = previousWrite;
  }
}
