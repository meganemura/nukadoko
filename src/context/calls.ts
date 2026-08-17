import type { CallEntry } from "../record/types.js";
import type { Step } from "../step/define-step.js";

// Responsibility: the call-tree bookkeeping behind `ctx.call` (docs/spec.md
// "Parts") — same collector shape as sections.ts/used.ts (owned and reset
// by the executor's step boundary, never reachable from a step's own `run`
// beyond the write-only `call(part, args)` call itself), widened by one
// thing neither of those needs: a part calling a part must be checked
// against *that part's own* `parts`, not the top-level step's, so this
// module tracks a stack of frames rather than one flat log.
//
// A frame is "whichever step's own `parts` currently governs the next
// `call()`" plus that frame's own accumulated children. `beginRoot` opens
// the outermost frame (the step whose step record this execution belongs
// to); `pushFrame`/`popFrame` open and close one frame per `call()`
// invocation, around that call's own `part.run()`, so a call a part makes
// from *inside* its own `run` is checked against the part's `parts`, and its
// own finished `CallEntry` lands in the *popped* frame's children — which
// `create-context.ts`'s `call()` implementation then folds into that
// entry's own `calls` before recording it in whatever frame is current once
// the frame that produced it is gone.
//
// This assumes a step's own body awaits one `call()` before starting
// another, the same sequential-execution assumption every other collector
// in this package already makes (create-context.ts's own header: `ctx` is
// shared per pickle, one step boundary at a time). A step that fired two
// `call()`s concurrently (`Promise.all([call(a, ...), call(b, ...)])`)
// would interleave two frame stacks into one and produce a corrupted call
// tree — not a case docs/spec.md "Parts" describes, and not one this module
// tries to detect.

interface Frame {
  readonly step: Step;
  readonly children: CallEntry[];
}

export interface CallsCollector {
  /** Opens the outermost frame, for `rootStep` — the step whose step record
   * this execution's `calls` field will belong to. Replaces any previous
   * frames outright, the same "one step boundary, fresh state" rule
   * `reset()` already follows. */
  beginRoot(rootStep: Step): void;
  /** The step whose own `parts` the next `call()` must find its target in —
   * the innermost frame currently open. `undefined` before `beginRoot` (or
   * after `reset()`) has ever run this step boundary. */
  currentStep(): Step | undefined;
  /** Opens a new, innermost frame for `part`, right before its own `run()`
   * starts — a call `part.run` itself makes is checked against `part`'s own
   * `parts`, never the frame that called it. */
  pushFrame(part: Step): void;
  /** Closes the innermost frame and returns whatever it itself accumulated
   * (`[]` when that part called no parts of its own) — the caller folds
   * this into the finished `CallEntry.calls` before passing it to
   * `recordEntry`. Must be called exactly once per `pushFrame`, whether the
   * part's own execution succeeded or threw. */
  popFrame(): readonly CallEntry[];
  /** Appends a finished `CallEntry` to whichever frame is currently
   * innermost — the frame that made this call, not the one this call
   * itself may have pushed and already popped. */
  recordEntry(entry: CallEntry): void;
  /** The root frame's own accumulated entries, in call order — what a step
   * record's own `calls` field is built from. `[]` when nothing was ever
   * called this step boundary. */
  snapshot(): CallEntry[];
  /** Executor-only: clears every frame at a step boundary. */
  reset(): void;
}

export function createCallsCollector(): CallsCollector {
  let frames: Frame[] = [];

  function current(): Frame {
    const frame = frames[frames.length - 1];
    if (frame === undefined) {
      throw new Error(
        "internal: ctx.call() reached with no active step frame; " +
          "beginStepRun() should have opened the root frame before this step's own run() was ever called",
      );
    }
    return frame;
  }

  return {
    beginRoot(rootStep: Step): void {
      frames = [{ step: rootStep, children: [] }];
    },
    currentStep(): Step | undefined {
      return frames[frames.length - 1]?.step;
    },
    pushFrame(part: Step): void {
      frames.push({ step: part, children: [] });
    },
    popFrame(): readonly CallEntry[] {
      const frame = frames.pop();
      return frame?.children ?? [];
    },
    recordEntry(entry: CallEntry): void {
      current().children.push(entry);
    },
    snapshot(): CallEntry[] {
      return [...(frames[0]?.children ?? [])];
    },
    reset(): void {
      frames = [];
    },
  };
}
