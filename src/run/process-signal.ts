import { constants } from "node:os";

// Responsibility: SIGINT, SIGTERM, and SIGHUP handling for the process that owns
// fixture caches. Node's default action for those signals exits the
// process at once, and the fixture teardown in `nuka run` and `nuka do`
// runs only after the step returns, so a signal during a step skips every
// teardown. A listener replaces that default. The first signal runs the
// scenario cleanup (scenario-scope fixtures, then context dispose) and
// then the process cleanup (process-scope fixtures), then exits with 128
// plus the signal number. A second signal exits at once, so a teardown
// that does not return can still be abandoned. `stop()` removes the
// listeners. A normal return must do that: the test runner calls `runCli`
// in-process, and a listener left behind would exit that process on the
// next SIGINT.

export type SignalCleanup = () => Promise<void>;

export interface ProcessSignal {
  /** True after the first SIGINT or SIGTERM. Fixture teardown reads this
   * so an interrupted invocation reports `"failed"` to `use()`. */
  readonly interrupted: boolean;
  /** Scenario-scope teardown for the scenario currently executing.
   * `null` outside one. Replaced as each scenario starts and ends. */
  setScenarioCleanup(cleanup: SignalCleanup | null): void;
  /** Process-scope teardown for this invocation. */
  setProcessCleanup(cleanup: SignalCleanup | null): void;
  /** Acts as if `signal` had arrived. A `nuka run --concurrency` worker
   * calls it when its parent is gone. */
  trigger(signal: NodeJS.Signals): void;
  stop(): void;
}

export const HANDLED_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export function exitCodeForSignal(signal: NodeJS.Signals): number {
  return 128 + (constants.signals[signal] ?? 0);
}

/** One shared run of `fn` for the normal path and the signal path.
 * The `started` flag is set before `fn` can await, and a signal is
 * delivered on a later turn, so the two callers cannot both pass the
 * check. */
export function runOnce(fn: () => Promise<void>): () => Promise<void> {
  let started = false;
  let pending: Promise<void> = Promise.resolve();
  return () => {
    if (!started) {
      started = true;
      pending = fn();
    }
    return pending;
  };
}

export function installProcessSignalHandlers(): ProcessSignal {
  let interrupted = false;
  let exiting = false;
  let scenarioCleanup: SignalCleanup | null = null;
  let processCleanup: SignalCleanup | null = null;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (exiting) {
      process.exit(exitCodeForSignal(signal));
    }
    exiting = true;
    interrupted = true;
    // Captured before the first await. A scenario that finishes while
    // teardown is in progress may clear the registered cleanup; this call
    // already holds the function that owns the fixtures.
    const scenario = scenarioCleanup;
    const processLevel = processCleanup;
    void (async () => {
      try {
        await scenario?.();
        await processLevel?.();
      } catch {
        // Teardown turns a fixture failure into a reported message. Anything
        // else still has to reach the exit below, or the process would stay
        // up with the default action already removed.
      } finally {
        process.exit(exitCodeForSignal(signal));
      }
    })();
  };

  for (const signal of HANDLED_SIGNALS) {
    process.on(signal, onSignal);
  }

  return {
    get interrupted() {
      return interrupted;
    },
    setScenarioCleanup(cleanup) {
      scenarioCleanup = cleanup;
    },
    setProcessCleanup(cleanup) {
      processCleanup = cleanup;
    },
    trigger: onSignal,
    stop() {
      // Leave the listener in place once a signal has started teardown.
      // Removing it would restore the default action and race the exit
      // this handler is about to perform. A second signal still needs
      // this listener so it can exit without waiting.
      if (exiting) return;
      for (const signal of HANDLED_SIGNALS) {
        process.off(signal, onSignal);
      }
    },
  };
}
