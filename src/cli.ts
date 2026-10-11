#!/usr/bin/env node
import { runCli } from "./cli/run-cli.js";

// Responsibility: the process entry point installed as `nuka`. Everything
// that can be unit-tested without spawning a process lives in
// cli/run-cli.ts; this file only owns argv/exit-code plumbing.

const exitCode = await runCli(process.argv.slice(2));
// A write larger than the free space in a pipe is only partly accepted.
// The rest stays queued until the reader makes room. process.exit in that
// same turn drops the queue, and the reader sees a cut-off document with
// exit code 0. An empty write is ordered after every chunk already queued,
// so its callback runs only once those chunks have reached the pipe.
await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
process.exit(exitCode);

function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => {
      resolve();
    });
  });
}
