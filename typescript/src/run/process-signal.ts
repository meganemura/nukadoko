import { constants } from "node:os";
import { signalCommandGroups } from "../context/run-command.js";
import { exitProcess } from "./project-exit.js";

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
//
// Each signal also goes, at once and before any teardown, to every
// `runCommand` process a step still runs in a process group of its own
// (src/context/run-command.ts): a terminal sends its Ctrl-C or hangup to
// its foreground group, which such a process left, so without this the
// signal would reach nukadoko alone.
//
// A record of how the process ended (`setExitRecord`) runs right before
// each exit this handler makes, after the teardown, and synchronously:
// `nuka run --step` writes there that the walk was interrupted, which a
// `nuka step` in another process reads. The default action would exit
// past it.

export type SignalCleanup = () => Promise<void>;

/** Writes how the process ended, right before a signal's exit. */
export type ExitRecord = (signal: NodeJS.Signals, exitCode: number) => void;

export interface ProcessSignal {
  /** True after the first SIGINT or SIGTERM. Fixture teardown reads this
   * so an interrupted invocation reports `"failed"` to `use()`. */
  readonly interrupted: boolean;
  /** Scenario-scope teardown for the scenario currently executing.
   * `null` outside one. Replaced as each scenario starts and ends. */
  setScenarioCleanup(cleanup: SignalCleanup | null): void;
  /** Process-scope teardown for this invocation. */
  setProcessCleanup(cleanup: SignalCleanup | null): void;
  /** What to record right before a signal's exit, after the teardown. */
  setExitRecord(record: ExitRecord | null): void;
  /** Acts as if `signal` had arrived. A `nuka run --concurrency` worker
   * calls it when its parent is gone. */
  trigger(signal: NodeJS.Signals): void;
  /** Never settles. A caller that finds `interrupted` awaits it so that it
   * does no more, such as writing the record of a run a signal ended, while
   * the handler finishes its cleanup and exits. */
  untilExit(): Promise<never>;
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
  let exitRecord: ExitRecord | null = null;
  // A record that throws must not keep the process from exiting.
  const exitRecorded = (signal: NodeJS.Signals): never => {
    try {
      exitRecord?.(signal, exitCodeForSignal(signal));
    } catch {
      // The exit below is what the signal asked for.
    }
    return exitProcess(exitCodeForSignal(signal));
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    signalCommandGroups(signal);
    if (exiting) {
      exitRecorded(signal);
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
        exitRecorded(signal);
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
    setExitRecord(record) {
      exitRecord = record;
    },
    trigger: onSignal,
    untilExit: () => new Promise<never>(() => {}),
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
