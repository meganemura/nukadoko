#!/usr/bin/env node
import { runCli } from "./cli/run-cli.js";

// Responsibility: the process entry point installed as `nuka`. Everything
// that can be unit-tested without spawning a process lives in
// cli/run-cli.ts; this file only owns argv/exit-code plumbing.

const exitCode = await runCli(process.argv.slice(2));
process.exit(exitCode);
