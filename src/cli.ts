#!/usr/bin/env node
import { runCli } from "./cli/run-cli.js";

// Responsibility: the process entry point installed as `nuka`. Everything
// that can be unit-tested without spawning a process lives in
// cli/run-cli.ts; this file only owns argv/exit-code plumbing.

// Saved before `runCli`: `run`, `do`, and `explore` point
// `process.stdout.write` at stderr, and the flush below has to wait on the
// real stdout.
const stdoutWrite = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);
const exitCode = await runCli(process.argv.slice(2));
// A write larger than the free space in a pipe is only partly accepted.
// The rest stays queued until the reader makes room. process.exit in that
// same turn drops the queue, and the reader sees a cut-off document with
// exit code 0. An empty write is ordered after every chunk already queued,
// so its callback runs only once those chunks have reached the pipe.
await Promise.all([flushed(stdoutWrite), flushed(stderrWrite)]);
process.exit(exitCode);

function flushed(write: (chunk: string, callback: () => void) => boolean): Promise<void> {
  return new Promise((resolve) => {
    write("", () => {
      resolve();
    });
  });
}
