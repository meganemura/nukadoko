import type { PollOptions } from "../context.js";

// Responsibility: `ctx.poll` per docs/spec.md "Context API" — submit-poll-
// fetch against asynchronous jobs. Kept independent of
// context/create-context.ts so it's unit-testable on its own and trivially
// reusable as the literal `poll` property there (same signature as
// `StepContext["poll"]`, so no adapter is needed at the call site).

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 500;

export class PollTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly description: string | undefined;

  constructor(timeoutMs: number, description: string | undefined) {
    const label = description ? ` while waiting for ${description}` : "";
    super(`poll timed out after ${timeoutMs}ms${label}`);
    this.name = "PollTimeoutError";
    this.timeoutMs = timeoutMs;
    this.description = description;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function poll<T>(fn: () => Promise<T>, options: PollOptions = {}): Promise<T> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const interval = options.interval ?? DEFAULT_INTERVAL_MS;
  const startedAt = Date.now();

  for (;;) {
    const value = await fn();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - startedAt >= timeout) {
      throw new PollTimeoutError(timeout, options.description);
    }
    await sleep(interval);
  }
}
