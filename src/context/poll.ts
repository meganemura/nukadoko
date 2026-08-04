// Responsibility: `ctx.poll`'s own retry loop (docs/spec.md "Context API") —
// the submit-poll-fetch wait for a value that has been asked for but is not
// there yet. This module no longer exports a runnable `poll`: that was a
// pure import for exactly as long as it recorded nothing (`import { poll }
// from "nukadoko"`, src/index.ts, pre-ctx-poll-receipt), and a wait that
// leaves no trace cannot be told apart, from a receipt, from one that
// returned on its first attempt — the two call for opposite fixes (see
// docs/spec.md's own "Helpers live as imports..." paragraph: this was the
// same mistake `ctx.section` made once already, reached from the opposite
// direction). Recording it means writing into the executor-owned `polls`
// collector (src/context/polls.ts), which this module has no access to —
// so `pollWithRecording` below takes a plain callback instead, and
// create-context.ts is the only caller, binding that callback to the
// collector to produce the `ctx.poll` a step actually calls.

export interface PollOptions {
  /** Total time budget for polling, in milliseconds. */
  timeout?: number;
  /** Delay between poll attempts, in milliseconds. */
  interval?: number;
  /** Human-readable label. Included in `PollTimeoutError`'s message when
   * this poll times out, and in the receipt's own `polls` entry regardless
   * of how the poll ended (docs/spec.md "Receipts") — the same label both
   * names the failure and identifies the record of the wait that produced
   * it. */
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

/** What one finished poll measured — everything `PollsCollector.record`
 * needs beyond `options.description`, which the caller (create-context.ts)
 * already has in scope. */
export interface PollOutcome {
  readonly attempts: number;
  readonly waitedMs: number;
  readonly outcome: "resolved" | "timed_out" | "failed";
}

/**
 * Runs the submit-poll-fetch loop and hands the result to `onFinish` exactly
 * once, however the loop ends (ctx-poll-receipt task spec: "timed_out も
 * failed も必ず記録される" — a `try`/`finally` around the whole loop is what
 * guarantees that, rather than calling `onFinish` at each individual exit
 * point, which a future change to this function could otherwise miss). The
 * outcome defaults to `"resolved"`: the only two paths that override it
 * (`fn` throwing, the timeout firing) each set it just before their own
 * `throw`, and `finally` always runs before that `throw` actually leaves
 * this function.
 *
 * `fn`'s own throw is rethrown unchanged (`throw error`, not wrapped) — this
 * function only ever observes it to classify it as `"failed"`, never
 * swallows it (docs/spec.md's design principle: nothing breaks silently).
 */
export async function pollWithRecording<T>(
  fn: () => Promise<T | undefined>,
  options: PollOptions,
  onFinish: (outcome: PollOutcome) => void,
): Promise<T> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const interval = options.interval ?? DEFAULT_INTERVAL_MS;
  const startedAt = Date.now();
  let attempts = 0;
  let outcome: PollOutcome["outcome"] = "resolved";

  try {
    for (;;) {
      attempts += 1;
      let value: T | undefined;
      try {
        value = await fn();
      } catch (error) {
        outcome = "failed";
        throw error;
      }
      if (value !== undefined) {
        return value;
      }
      if (Date.now() - startedAt >= timeout) {
        outcome = "timed_out";
        throw new PollTimeoutError(timeout, options.description);
      }
      await sleep(interval);
    }
  } finally {
    onFinish({ attempts, waitedMs: Date.now() - startedAt, outcome });
  }
}
