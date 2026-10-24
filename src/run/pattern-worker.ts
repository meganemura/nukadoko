import { Worker } from "node:worker_threads";
import { withoutChannelRecording } from "../context/create-context.js";
import type { PatternOutcome } from "../step/evaluate-claims.js";

// Responsibility: test a `matches` claim's regular expression where it can
// be stopped (docs/spec.md "Claims"). A pattern that backtracks can run for
// minutes on a short text, and JavaScript cannot interrupt a regular
// expression running on its own thread: the step's deadline never fires
// and the run ignores SIGTERM until the pattern returns. So the pattern
// runs on a worker thread, and a pattern that runs past the time it is
// given is stopped by terminating the worker; the next test starts a new
// one.
//
// One worker serves every claim of the process, because starting one costs
// tens of milliseconds and a polled claim is judged ten times a second. It
// is unreferenced, so it never keeps the process alive. The executor starts
// it before a claim step's reading begins (`startPatternWorker`), so the
// time a start takes is not taken from the time a pattern is given, and it
// starts every worker with channel recording suppressed, so the step record
// never shows nukadoko's own worker as an action of the step, also when a
// worker stopped for a slow pattern is replaced in the middle of a poll.

// process.getBuiltinModule, not require: an eval worker inherits the
// parent's execArgv, and under --input-type=module its source is an ES
// module, where require does not exist.
const WORKER_SOURCE = `
const { parentPort } = process.getBuiltinModule("node:worker_threads");
parentPort.on("message", ({ id, pattern, text }) => {
  let built;
  try {
    built = new RegExp(pattern);
  } catch (error) {
    parentPort.postMessage({ id, reason: "matches could not build a regular expression: " + (error && error.message) });
    return;
  }
  const matchesEmpty = new RegExp(pattern).test("");
  parentPort.postMessage({ id, holds: built.test(text), matchesEmpty });
});
`;

type Answer = { readonly id: number; readonly holds: boolean; readonly matchesEmpty: boolean } | { readonly id: number; readonly reason: string };

interface Pending {
  readonly resolve: (outcome: PatternOutcome) => void;
  readonly reject: (error: Error) => void;
}

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, Pending>();

function stop(error: Error): void {
  const stopped = worker;
  worker = undefined;
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
  void stopped?.terminate();
}

/** Starts the worker if none runs. Idempotent. Call it outside the scope
 * that records a step's actions. */
export function startPatternWorker(): void {
  if (worker !== undefined) return;
  const started = withoutChannelRecording(() => new Worker(WORKER_SOURCE, { eval: true }));
  started.on("message", (answer: Answer) => {
    const entry = pending.get(answer.id);
    if (entry === undefined) return;
    pending.delete(answer.id);
    entry.resolve("reason" in answer ? { reason: answer.reason } : { holds: answer.holds, matchesEmpty: answer.matchesEmpty });
  });
  started.on("error", (error: unknown) => {
    if (worker === started) stop(error instanceof Error ? error : new Error(String(error)));
  });
  started.on("exit", () => {
    if (worker === started) stop(new Error("the worker that tests regular expressions stopped"));
  });
  // After the listeners: adding a `message` listener refs the worker
  // again (measured on Node 22.22.0), and a referenced worker keeps a
  // `--concurrency` worker process alive after its last scenario, with
  // the parent waiting on it.
  started.unref();
  worker = started;
}

/** Tests `pattern` against `text` on the worker, giving it at most
 * `timeoutMs`; `limit` says in the reason what that time was. Rejects only
 * when the worker failed, which the judging records as a claim it could
 * not judge. */
export function testPatternInWorker(pattern: string, text: string, timeoutMs: number, limit: string): Promise<PatternOutcome> {
  startPatternWorker();
  const current = worker!;
  const id = nextId++;
  return new Promise<PatternOutcome>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      resolve({ reason: `matches did not finish within ${Math.round(timeoutMs)}ms (${limit}), so nukadoko stopped the pattern` });
      if (worker === current) stop(new Error("the worker that tests regular expressions was stopped for a pattern that ran too long"));
    }, timeoutMs);
    pending.set(id, {
      resolve: (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    current.postMessage({ id, pattern, text });
  });
}
