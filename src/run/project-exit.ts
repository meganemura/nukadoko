// Responsibility: keep project code from ending the nuka process with
// `process.exit`, in `nuka run` and `nuka do`. Boundary: which step or
// hook fails is the deadline's (step-deadline.ts); this module only turns
// the call into an error, and holds one that no project code caught.
//
// A step runs in the same process as the run that judges it. A real
// `process.exit(0)` in a step ended `nuka run` with exit code 0 after an
// earlier scenario failed, with no run.json and no finding: the step chose
// the run's verdict. The replacement throws instead, so a call inside a
// step, a hook, a fixture, or a World fails it the way any throw does, and
// the run goes on with its own verdict and exit code.
//
// A call from a timer or a promise that nothing awaited throws where no
// step is waiting for it. Node would end the process for that throw, so a
// listener keeps it, and the next step or hook to finish fails with it.
// Any other uncaught error still ends the process as Node does, with exit
// code 1. The replacement is never put back: a timer a step left can fire
// after the run printed its last line, and nukadoko's own exits use
// `exitProcess`, taken before the switch.
//
// A `--concurrency` worker does not hold the call. There, the parent
// counts the records a worker wrote and reports the missing ones as
// `run-incomplete`.

const ownExit = process.exit.bind(process);

/** Ends the process. nukadoko's own exits call this, never
 * `process.exit`, which project code may not reach once it is held. */
export function exitProcess(code?: number): never {
  return ownExit(code);
}

/** What `process.exit` throws while it is held. */
export class ProcessExitCall extends Error {
  readonly code: unknown;
  constructor(code: unknown, from: "here" | "elsewhere") {
    const call = `process.exit(${code === undefined ? "" : String(code)})`;
    super(
      from === "here"
        ? `${call} was called; project code cannot end nuka, so this fails instead`
        : `${call} was called from a timer or a promise that nothing awaited; project code cannot end nuka, so the next step or hook to finish fails instead`,
    );
    this.name = "ProcessExitCall";
    this.code = code;
  }
}

let held = false;
let escaped: ProcessExitCall | undefined;

/** Makes `process.exit` throw a `ProcessExitCall` for the rest of the
 * process. A second call does nothing. */
export function holdProcessExit(): void {
  if (held) return;
  held = true;
  process.exit = ((code?: unknown) => {
    throw new ProcessExitCall(code, "here");
  }) as typeof process.exit;
  const onUncaught = (error: unknown): void => {
    if (error instanceof ProcessExitCall) {
      escaped ??= new ProcessExitCall(error.code, "elsewhere");
      return;
    }
    // Thrown again on a turn with no listener, so Node prints it and
    // exits with code 1, as it does when nothing listens. A throw inside
    // the listener would exit with code 7.
    process.off("uncaughtException", onUncaught);
    process.nextTick(() => {
      throw error;
    });
  };
  process.on("uncaughtException", onUncaught);
}

/** The call no project code caught since the last take, once. */
export function takeEscapedExit(): ProcessExitCall | undefined {
  const taken = escaped;
  escaped = undefined;
  return taken;
}
