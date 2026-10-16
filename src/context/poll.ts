import type { PollOptions } from "../step/context.js";

// Responsibility: `ctx.poll`'s own retry loop (docs/spec.md "Context API") —
// the submit-poll-fetch wait for a value that has been asked for but is not
// there yet. This module no longer exports a runnable `poll`: that was a
// pure import for exactly as long as it recorded nothing (`import { poll }
// from "nukadoko"`, src/index.ts), and a wait that
// leaves no trace cannot be told apart, from a step record, from one that
// returned on its first attempt — the two call for opposite fixes (see
// docs/spec.md's own "Helpers live as imports..." paragraph: this was the
// same mistake `ctx.section` made once already, reached from the opposite
// direction). Recording it means writing into the executor-owned `polls`
// collector (src/context/polls.ts), which this module has no access to —
// so `pollWithRecording` below takes a plain callback instead, and
// create-context.ts is the only caller, binding that callback to the
// collector to produce the `ctx.poll` a step actually calls.

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

/** Thrown before the first attempt when `timeout` or `interval` cannot be a
 * budget. A missing option is not this case: it uses the default. `NaN` and
 * `Infinity` are, because `elapsed >= timeout` is never true for either, so
 * the loop would not end. Zero and a negative number are too: a budget that
 * is already spent cannot contain an attempt, and a non-positive interval
 * collapses into a tight timer loop. The value is named in the message
 * because `Number(process.env.SOME_TIMEOUT)` is a common way to arrive here
 * with `NaN`, and the message is the only place that says which option. */
export class InvalidPollOptionsError extends Error {
  readonly option: "timeout" | "interval";
  readonly value: number;

  constructor(option: "timeout" | "interval", value: number) {
    super(`poll ${option} must be a finite number of milliseconds greater than 0 (got ${String(value)})`);
    this.name = "InvalidPollOptionsError";
    this.option = option;
    this.value = value;
  }
}

type BudgetResult<T> = { readonly status: "value"; readonly value: T } | { readonly status: "timeout" };

function requirePositiveMs(value: number, option: "timeout" | "interval"): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidPollOptionsError(option, value);
  }
}

interface CancellableDelay {
  readonly done: Promise<void>;
  cancel(): void;
}

function delay(ms: number): CancellableDelay {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timer = undefined;
      resolve();
    }, ms);
  });
  return {
    done,
    cancel() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/**
 * Resolves with `work`'s value, or with `status: "timeout"` when `budgetMs`
 * elapses first. The attempt is not cancelled: `fn` has no signal to observe.
 * What this does stop is using that late settlement as the poll's result. A
 * value that arrives after the budget is dropped, and a rejection that arrives
 * after it is swallowed. Leaving that rejection unhandled would fail the
 * process for an attempt the caller has already been told timed out.
 */
async function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<BudgetResult<T>> {
  let abandon = false;
  const guarded = work.then(
    (value) => value,
    (error: unknown) => {
      if (abandon) return undefined as T;
      throw error;
    },
  );
  const timer = delay(budgetMs);
  try {
    const winner = await Promise.race([
      guarded.then((value) => ({ settled: "value" as const, value })),
      timer.done.then(() => ({ settled: "timeout" as const })),
    ]);
    if (winner.settled === "timeout") {
      abandon = true;
      void guarded.catch(() => {});
      return { status: "timeout" };
    }
    return { status: "value", value: winner.value };
  } finally {
    timer.cancel();
  }
}

/** What one finished poll measured — everything `PollsCollector.record`
 * needs beyond `options.description`, which the caller (create-context.ts)
 * already has in scope. */
export interface PollOutcome {
  readonly attempts: number;
  readonly waitedMs: number;
  readonly outcome: "resolved" | "timed_out" | "failed";
  /** ISO 8601 — this poll's own start,
   * derived from the same `startedAt` epoch-ms value already used to compute
   * `waitedMs` below, so the two can never disagree about when this poll
   * began. Exposed so `PollRecord.at` (src/record/types.ts) can place this
   * poll on the same absolute timeline `sections`' own `at` and
   * `evidence.screenshots[].at` already share. */
  readonly at: string;
}

/**
 * Runs the submit-poll-fetch loop and hands the result to `onFinish` exactly
 * once, however the loop ends — a timeout and a `fn` throw must be recorded
 * too, not only a resolved value, which is why a `try`/`finally` around the
 * whole loop guarantees that, rather than calling `onFinish` at each
 * individual exit point, which a future change to this function could
 * otherwise miss. The
 * outcome defaults to `"resolved"`: the only two paths that override it
 * (`fn` throwing, the timeout firing) each set it just before their own
 * `throw`, and `finally` always runs before that `throw` actually leaves
 * this function.
 *
 * `fn`'s own throw is rethrown unchanged (`throw error`, not wrapped) — this
 * function only ever observes it to classify it as `"failed"`, never
 * swallows it, because a failure that vanishes cannot be traced.
 *
 * `onProgress`, when given, is called once per loop iteration, right after
 * `attempts` is incremented and before `fn` runs. A poll waiting on a value
 * that never arrives for minutes is still visible attempt by attempt this
 * way, not only once the whole call finally settles. It must never throw:
 * this function does not guard the call with its own `try`/`catch`, so a
 * throwing `onProgress` would escape as if it were `fn`'s own failure. The
 * one caller today (create-context.ts) only ever assigns into a plain map,
 * which cannot throw.
 *
 * `timeout` is a budget for the whole call, not a check that runs once an
 * attempt has already returned. Each attempt, and each sleep between
 * attempts, is raced against the time still left. An attempt that does not
 * settle inside that remainder is a timeout, and so is a sleep that would
 * start the next attempt after the budget. A value produced after the
 * budget has ended is not returned. Invalid `timeout` or `interval` throws
 * before this loop, and is not recorded: there is no attempt to count.
 */
export async function pollWithRecording<T>(
  fn: () => Promise<T | undefined>,
  options: PollOptions,
  onFinish: (outcome: PollOutcome) => void,
  onProgress?: (attempts: number) => void,
): Promise<T> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const interval = options.interval ?? DEFAULT_INTERVAL_MS;
  requirePositiveMs(timeout, "timeout");
  requirePositiveMs(interval, "interval");
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  let attempts = 0;
  let outcome: PollOutcome["outcome"] = "resolved";
  const failTimedOut = (): never => {
    outcome = "timed_out";
    throw new PollTimeoutError(timeout, options.description);
  };

  try {
    for (;;) {
      const budget = timeout - (Date.now() - startedAt);
      if (!(budget > 0)) failTimedOut();
      attempts += 1;
      onProgress?.(attempts);
      let value: T | undefined;
      let attempt: BudgetResult<T | undefined>;
      try {
        attempt = await withinBudget(fn(), budget);
      } catch (error) {
        outcome = "failed";
        throw error;
      }
      // Thrown out here, not inside the `catch` above: that `catch` is only
      // `fn`'s own failure. Folding the timeout into it would record the
      // attempt as `"failed"`. The `else` is what narrows `attempt` to the
      // value arm: a `never`-returning call in the `if` does not.
      if (attempt.status === "timeout") {
        failTimedOut();
      } else {
        value = attempt.value;
      }
      if (value !== undefined) {
        return value;
      }
      const left = timeout - (Date.now() - startedAt);
      // The next attempt cannot start until `interval` has passed. If that
      // wait would itself cross the budget, waiting it out and then calling
      // `fn` again is how a value from after the deadline used to be returned.
      if (!(left > 0) || left < interval) failTimedOut();
      const pause = delay(interval);
      try {
        const slept = await withinBudget(pause.done, left);
        if (slept.status === "timeout") failTimedOut();
      } finally {
        pause.cancel();
      }
    }
  } finally {
    onFinish({ attempts, waitedMs: Date.now() - startedAt, outcome, at: startedAtIso });
  }
}
