// Responsibility: the minimal output-stream interface CLI command handlers
// need. Narrower than NodeJS.WritableStream on purpose: it's the entire
// surface any command uses, and it's trivial to fake in a test without
// matching the real stream interface's many unrelated members. Its own
// module (not declared in run-cli.ts) so both run-cli.ts and cli/do.ts can
// depend on it without importing from each other.

export interface WritableSink {
  write(chunk: string): unknown;
}
