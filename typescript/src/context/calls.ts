import { AsyncLocalStorage } from "node:async_hooks";
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
// to); `enter` creates one frame per `call()` invocation and `within` runs
// that call's own `part.run()` inside it, so a call a part makes from
// *inside* its own `run` is checked against the part's `parts`, and lands
// in the part's frame.
//
// The current frame follows the async call chain (AsyncLocalStorage), not a
// global stack: a step may start `call(a)` and `call(b)` concurrently
// (`Promise.all`), and each part must see itself as its own callers' frame
// while the other is still running. Code outside any `within` (the step's
// own body) falls back to the root frame.
//
// `reserve` takes a child's place in its parent when the call starts, so
// siblings appear in start order whatever order they finish in.

export interface Frame {
  readonly step: Step;
  readonly children: (CallEntry | undefined)[];
}

export interface CallsCollector {
  /** Opens the outermost frame, for `rootStep` — the step whose step record
   * this execution's `calls` field will belong to. Replaces any previous
   * frame outright, the same "one step boundary, fresh state" rule
   * `reset()` already follows. */
  beginRoot(rootStep: Step): void;
  /** The step whose own `parts` the next `call()` must find its target in —
   * the frame of the current async call chain. `undefined` before
   * `beginRoot` (or after `reset()`) has ever run this step boundary. */
  currentStep(): Step | undefined;
  /** Takes the next child position in the current frame and returns the
   * function that fills it with the finished `CallEntry`. Call it once per
   * `call()` that gets as far as starting, and fill it exactly once. */
  reserve(): (entry: CallEntry) => void;
  /** Creates the frame for `part`'s own execution. */
  enter(part: Step): Frame;
  /** Runs `fn` with `frame` as the current frame of its whole async chain. */
  within<T>(frame: Frame, fn: () => T): T;
  /** The finished entries a frame accumulated, in start order. */
  entriesOf(frame: Frame): readonly CallEntry[];
  /** The root frame's own accumulated entries, in start order — what a step
   * record's own `calls` field is built from. `[]` when nothing was ever
   * called this step boundary. */
  snapshot(): CallEntry[];
  /** Executor-only: clears the root frame at a step boundary. */
  reset(): void;
}

export function createCallsCollector(): CallsCollector {
  let root: Frame | undefined;
  const chain = new AsyncLocalStorage<Frame>();

  function current(): Frame {
    const frame = chain.getStore() ?? root;
    if (frame === undefined) {
      throw new Error(
        "internal: ctx.call() reached with no active step frame; " +
          "beginStepRun() should have opened the root frame before this step's own run() was ever called",
      );
    }
    return frame;
  }

  function entriesOf(frame: Frame): CallEntry[] {
    return frame.children.filter((entry): entry is CallEntry => entry !== undefined);
  }

  return {
    beginRoot(rootStep: Step): void {
      root = { step: rootStep, children: [] };
    },
    currentStep(): Step | undefined {
      return (chain.getStore() ?? root)?.step;
    },
    reserve(): (entry: CallEntry) => void {
      const { children } = current();
      const index = children.length;
      children.push(undefined);
      return (entry) => {
        children[index] = entry;
      };
    },
    enter(part: Step): Frame {
      return { step: part, children: [] };
    },
    within<T>(frame: Frame, fn: () => T): T {
      return chain.run(frame, fn);
    },
    entriesOf,
    snapshot(): CallEntry[] {
      return root === undefined ? [] : entriesOf(root);
    },
    reset(): void {
      root = undefined;
    },
  };
}
