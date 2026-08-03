// Responsibility: `poll` per docs/spec.md "Context API" — submit-poll-fetch
// against asynchronous jobs, exported as `import { poll } from "nukadoko"`
// (src/index.ts). It needs nothing the executor owns, so it lives outside
// `StepContext` entirely rather than as a `ctx` member (m2pre-ctx-surface
// task spec, decision 1: pure helpers are imports, not context members).

export interface PollOptions {
  /** Total time budget for polling, in milliseconds. */
  timeout?: number;
  /** Delay between poll attempts, in milliseconds. */
  interval?: number;
  /** Human-readable label included in the `PollTimeoutError` message. */
  description?: string;
}

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

export async function poll<T>(
  fn: () => Promise<T | undefined>,
  options: PollOptions = {},
): Promise<T> {
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
