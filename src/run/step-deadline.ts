import { CompatTimeoutError, isWorldWriteValidationError } from "../compat/errors.js";
import type { ErrorKind } from "../record/types.js";
import { takeEscapedExit } from "./project-exit.js";

// Responsibility: the deadline a step or a hook runs under, and how a
// value it threw is classified into the record's `error.kind`. Shared by
// the scenario runner (run-scenario.ts), `nuka do` (execute-typed-step.ts),
// and the run-scope hooks (cli/run.ts), so all of them name a timeout with
// the same words. run-scenario.ts re-exports both functions, so a module
// that already imports them from there keeps doing so.

/** This function's own failure message: names which timeout fired (a step's own
 * `{ timeout }` vs a hook's), on what, and the configured value. Not
 * exported: only `runWithTimeout` below builds one, and that function
 * itself is what cli/run.ts's own BeforeAll/AfterAll reuses (see this
 * file's own header). */
function timeoutMessage(kind: "Step" | "Hook", name: string, timeoutMs: number, source: TimeoutSource = "registered"): string {
  const where =
    source === "registered"
      ? "its own registered timeout"
      : source === "step"
        ? "the step's own timeout"
        : "stepTimeout in nukadoko.config.ts; raise it, or give this step its own timeout";
  return `${kind} "${name}" timed out after ${timeoutMs}ms (${where})`;
}

/** Which knob produced the limit that fired, so the message can name the
 * one to turn. `"registered"` is the compat path's own wording, unchanged:
 * there the limit came from the glue's `{ timeout }` or `setDefaultTimeout`,
 * neither of which nukadoko owns. */
export type TimeoutSource = "registered" | "step" | "config";

/**
 * Races `run()` against `timeoutMs` (when given) and returns whichever
 * settles first. Honest limit, spelled out here because it is easy to miss:
 * JavaScript cannot cancel an in-flight
 * Promise. A timed-out call's own body keeps executing to completion in
 * the background no matter what this function returns. All this actually
 * guarantees is that the step/hook that started it is recorded as failed
 * and `runScenario` moves on to whatever comes next; it does not stop the
 * timed-out work itself.
 *
 * `run()`'s own promise is given a no-op `.catch` up front regardless of
 * which side of the race wins: if it eventually rejects *after* losing to
 * the timeout, that rejection would otherwise be "unhandled" from Node's
 * point of view (Node terminates the whole process for an unhandled
 * rejection by default since Node 15), precisely the kind of hard crash a
 * per-step timeout must never cause.
 *
 * The timer itself is always cleared, on every path, so a step/hook that
 * finishes in time never leaks a pending Node timer.
 *
 * Exported so cli/run.ts's own
 * BeforeAll/AfterAll execution races against the exact same logic a
 * scenario's own compat step/hook already does, rather than a second,
 * potentially-drifting copy of it. A run-scope hook is still "a compat
 * hook with a `{ timeout }`" as far as this function is concerned, it is
 * only *where* it runs (once per `nuka run`, not once per pickle) that
 * differs, and that difference lives entirely in the caller.
 *
 * A negative `timeoutMs` on the compat source (`"registered"`, the default
 * every compat step and hook passes) means no timeout. cucumber-js arms a
 * timer only when the value is zero or greater, and `setDefaultTimeout(-1)`
 * plus a step or hook `{ timeout: -1 }` are how a suite turns the limit
 * off. Typed steps pass `"step"` or `"config"` and have no such idiom, so
 * a negative number there is still a limit. Zero still arms a timer on
 * every source: cucumber-js times out at zero too.
 */
export async function runWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number | undefined,
  kind: "Step" | "Hook",
  name: string,
  source: TimeoutSource = "registered",
): Promise<T> {
  // A process.exit no project code caught (project-exit.ts) fails the step
  // or hook that finishes next, before what it threw itself: its own error
  // is most likely what the exit call cut short.
  let value: T;
  try {
    value = await raceDeadline(run, timeoutMs, kind, name, source);
  } catch (error) {
    throw takeEscapedExit() ?? error;
  }
  const exited = takeEscapedExit();
  if (exited !== undefined) throw exited;
  return value;
}

async function raceDeadline<T>(
  run: () => Promise<T>,
  timeoutMs: number | undefined,
  kind: "Step" | "Hook",
  name: string,
  source: TimeoutSource,
): Promise<T> {
  const limit =
    source === "registered" && timeoutMs !== undefined && timeoutMs < 0 ? undefined : timeoutMs;
  if (limit === undefined) {
    return run();
  }
  const inFlight = run();
  inFlight.catch(() => {});
  let timer: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new CompatTimeoutError(timeoutMessage(kind, name, limit, source))),
      limit,
    );
  });
  try {
    return await Promise.race([inFlight, timedOut]);
  } finally {
    clearTimeout(timer!);
  }
}


/** Classifies a compat step's/hook's own thrown value into the closed
 * `error.kind` enum, identified by type, never by matching the thrown
 * value's own message text. Only
 * `CompatTimeoutError` (`runWithTimeout`, above, always constructed by this
 * very module) and a `WorldWriteValidationError` (a declared World key's
 * write, src/compat/world-instrumentation.ts, checked via
 * `isWorldWriteValidationError`'s own brand, not `instanceof`, since that
 * error is reached through discovery's own namespaced import and
 * `instanceof` would silently miss it there; see that function's own header)
 * are identifiable this way; anything else (including a non-`Error` thrown
 * value) falls back to `"step_error"`, the default whenever classification
 * is uncertain. A typed step's own catch site calls through here too: it
 * cannot produce a `WorldWriteValidationError` (no `this`), but it does run
 * under `runWithTimeout` now, so a `CompatTimeoutError` reaches it and has
 * to classify as `"timeout"` rather than as the step's own throw. */
export function classifyCaughtError(error: unknown): ErrorKind {
  if (error instanceof CompatTimeoutError) return "timeout";
  if (isWorldWriteValidationError(error)) return "world_invalid";
  return "step_error";
}
