import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

// Responsibility: send what one function running in nukadoko's own
// process prints (a world's `setup` or `url` function) somewhere other
// than the terminal, and nothing any other code prints. Boundary: where the
// captured text goes, and what a later write is redacted with, are the
// caller's (src/program/world.ts); this module only routes writes.
//
// The route is an AsyncLocalStorage store entered around the function, so
// it follows the function's own async work (a timer it armed, a request
// it sent, a server it started) and nothing else. Swapping the streams for
// the process while the function ran captured every other world's
// progress and every step's output under `--concurrency`, and, for a
// function past its limit, everything after it until it ended.
//
// The capture ends when the function settles, reaches its limit, or is
// abandoned because the start was stopped. A write the function's work
// makes after that goes where it always goes, the stream or the console
// method it was written to, redacted by the caller's rule, since a
// `{token}` the function holds is a secret wherever it is printed.
//
// `process.stdout.write`, `process.stderr.write`, and the `console`
// methods are wrapped once and stay wrapped: a function past its limit
// can write at any later time, and a write outside every route passes
// straight through. `console` is wrapped too, since a host such as a test
// runner can replace it with one that never reaches the streams. A wrapper
// replaced since (a test runner's console, or `nuka run`'s stdout
// diversion) is wrapped again when the next capture starts.

export interface OutputCapture {
  /** Runs `fn` with what its async work prints sent to the capture. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Ends the capture: later writes of `fn`'s work go where they always
   * go, through `after`. */
  end(): void;
}

interface Route {
  capturing: boolean;
  readonly into: (text: string) => void;
  readonly after: (text: string) => string;
}

const routes = new AsyncLocalStorage<Route>();
const WRAPPED = Symbol.for("nukadoko.inProcessOutput");
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

type Write = (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
type Marked<F> = F & { [WRAPPED]?: true };

function wrapStream(stream: NodeJS.WriteStream): void {
  const original = stream.write as Marked<Write>;
  if (original[WRAPPED]) return;
  const wrapper: Marked<Write> = function (this: unknown, chunk, ...rest) {
    const route = routes.getStore();
    if (route === undefined) return original.call(stream, chunk, ...rest);
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    // Each forward leaves every route first: `into` can write to
    // `process.stderr` itself, and the route must not capture its own
    // output again without end.
    if (route.capturing) {
      routes.exit(() => route.into(text));
      rest.find((arg): arg is () => void => typeof arg === "function")?.();
      return true;
    }
    return routes.exit(() => original.call(stream, route.after(text), ...rest.filter((arg) => typeof arg === "function")));
  };
  wrapper[WRAPPED] = true;
  stream.write = wrapper as typeof stream.write;
}

function wrapConsole(): void {
  for (const method of CONSOLE_METHODS) {
    const original = console[method] as Marked<(...args: unknown[]) => void>;
    if (original[WRAPPED]) continue;
    const wrapper: Marked<(...args: unknown[]) => void> = (...args) => {
      const route = routes.getStore();
      if (route === undefined) return original.apply(console, args);
      const text = `${format(...args)}\n`;
      if (route.capturing) return routes.exit(() => route.into(text));
      return routes.exit(() => original.call(console, route.after(text).replace(/\n$/, "")));
    };
    wrapper[WRAPPED] = true;
    console[method] = wrapper;
  }
}

/** A capture that sends what one function's async work prints to `into`
 * until it ends, and after that through `after` to where it was written
 * (module header). */
export function captureOutput(into: (text: string) => void, after: (text: string) => string): OutputCapture {
  const route: Route = { capturing: true, into, after };
  return {
    run(fn) {
      wrapStream(process.stdout);
      wrapStream(process.stderr);
      wrapConsole();
      return routes.run(route, fn);
    },
    end() {
      route.capturing = false;
    },
  };
}
