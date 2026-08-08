import type { FixtureDeps, FixtureFn, FixtureOutcome, UseFn } from "./types.js";

// Responsibility: runs *one* fixture function's own setup/teardown
// coroutine — `await use(value)` inside it suspends until this module's own
// caller (src/fixture/resolver.ts) later decides the outcome and calls
// `teardown()`. Playwright's own fixture engine is runner machinery keyed on
// `testInfo` (which test, which retry) that only Playwright's own test
// runner owns; nukadoko is its own runner, not Playwright's, so that engine
// cannot be borrowed (this task's spec, "前提") — the same "a function
// suspended on `use()`, resumed by teardown" shape is reimplemented here,
// from scratch, over a plain `Promise`.
//
// Nothing here knows about the fixture *graph*, scope, or caching — src/
// fixture/resolver.ts owns those and calls `startFixture` exactly once per
// fixture *instance* actually being built (never once per name: a
// `"process"`-scope fixture reused by a later scenario never reaches this
// module a second time).
//
// The timeout/misuse contract (this task's spec, item 7) exists because the
// previous `ctx.page()` had no call-contract of its own to violate — a
// step's own body called it, or didn't; there was nothing to await twice or
// forget to resolve. A fixture function is different: it is a coroutine
// this module resumes from the *outside*, so a fixture that never calls
// `use()`, or calls it twice, is a new way to hang or misbehave that this
// task's own P5-only slice introduces — and a named, thrown failure is
// always better than a `nuka run` that never returns.

export class FixtureUseNotCalledError extends Error {
  readonly fixture: string;

  constructor(fixture: string) {
    super(
      `Fixture "${fixture}" finished without ever calling use(...): every fixture must call ` +
        "use(value) exactly once, to hand its value to whatever named it",
    );
    this.name = "FixtureUseNotCalledError";
    this.fixture = fixture;
  }
}

export class FixtureUseCalledTwiceError extends Error {
  readonly fixture: string;

  constructor(fixture: string) {
    super(`Fixture "${fixture}" called use(...) more than once; a fixture may call it exactly once`);
    this.name = "FixtureUseCalledTwiceError";
    this.fixture = fixture;
  }
}

/** Fired when a fixture's own setup or teardown phase does not finish
 * within its timeout budget (`config.fixtureTimeout`, or the fixture's own
 * `options.timeout` override) — always names both the fixture and which
 * phase timed out (this task's spec, item 7: "どの fixture で止まったかを
 * 名指す"), so a `nuka run` that would otherwise hang forever fails loudly
 * and pointed at the exact line to look at instead. */
export class FixtureTimeoutError extends Error {
  readonly fixture: string;
  readonly phase: "setup" | "teardown";
  readonly timeoutMs: number;

  constructor(fixture: string, phase: "setup" | "teardown", timeoutMs: number) {
    super(`Fixture "${fixture}" timed out during ${phase} after ${timeoutMs}ms`);
    this.name = "FixtureTimeoutError";
    this.fixture = fixture;
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Races `promise` against `timeoutMs`, same shape as src/run/
 * run-scenario.ts's own `runWithTimeout` (not reused directly: that
 * function is specific to a compat step's/hook's `kind`/`name` message
 * wording, this one to `FixtureTimeoutError`'s own fields) — `promise` is
 * given a no-op `.catch` up front regardless of which side of the race
 * wins, so a promise that eventually settles *after* losing to the timeout
 * never becomes an "unhandled rejection" Node would otherwise terminate the
 * process over. The timer is always cleared, on every path. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface FixtureInstance {
  readonly value: unknown;
  /** Resumes the fixture past its own `await use(...)`, passing `outcome`,
   * and waits (up to `timeoutMs`) for whatever teardown code follows to
   * finish. Never throws (P5 task spec, scope item 6: "teardown の throw
   * は step / シナリオの成否を変えない") — a teardown failure is caught
   * and its message returned instead, for the caller to record without
   * letting it change any step's or scenario's own outcome. `undefined`
   * means teardown finished cleanly. */
  teardown(outcome: FixtureOutcome): Promise<string | undefined>;
}

/**
 * Starts `fn`, races its own first `use()` call against `timeoutMs`, and
 * returns once a value is available — `fn`'s own body keeps running in the
 * background past that point, suspended on `use()`'s own returned promise,
 * until the caller later invokes `teardown()` on the result.
 *
 * @throws {FixtureUseNotCalledError} `fn` settled (returned or threw)
 * without ever calling `use`.
 * @throws {FixtureTimeoutError} `fn` neither called `use` nor settled
 * within `timeoutMs` (phase `"setup"`).
 * @throws whatever `fn` itself threw before calling `use` — a genuine
 * setup failure, not a misuse of the `use()` contract.
 */
export async function startFixture(
  name: string,
  fn: FixtureFn,
  deps: FixtureDeps,
  timeoutMs: number,
): Promise<FixtureInstance> {
  const value = deferred<unknown>();
  const outcome = deferred<FixtureOutcome>();
  let useCallCount = 0;

  const use: UseFn = async (v) => {
    useCallCount += 1;
    if (useCallCount > 1) {
      throw new FixtureUseCalledTwiceError(name);
    }
    value.resolve(v);
    return outcome.promise;
  };

  const runPromise = (async () => {
    await fn(deps, use);
  })();

  // Handled here (not left for `teardown()` to be the first `.then`/`.catch`
  // on `runPromise`) so a rejection that happens between now and a later
  // `teardown()` call is never "unhandled" from Node's own point of view.
  const settledWithoutUse = runPromise.then(
    (): "returned" => "returned",
    (): "threw" => "threw",
  );

  const raced = await withTimeout(
    Promise.race([
      value.promise.then((v): { kind: "value"; value: unknown } => ({ kind: "value", value: v })),
      settledWithoutUse.then((how): { kind: "no-use"; how: "returned" | "threw" } => ({ kind: "no-use", how })),
    ]),
    timeoutMs,
    () => new FixtureTimeoutError(name, "setup", timeoutMs),
  );

  if (raced.kind === "no-use") {
    if (raced.how === "threw") {
      // Rethrows `fn`'s own rejection reason directly — a real setup
      // failure, distinct from the use()-contract violation below.
      await runPromise;
    }
    throw new FixtureUseNotCalledError(name);
  }

  return {
    value: raced.value,
    async teardown(finalOutcome) {
      outcome.resolve(finalOutcome);
      try {
        await withTimeout(runPromise, timeoutMs, () => new FixtureTimeoutError(name, "teardown", timeoutMs));
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
}
