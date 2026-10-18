import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { createObservedCollector } from "../src/context/observed.js";

type Call = "watch" | "GET" | "POST" | "process" | "reset";

const call = gs.sampledFrom<Call>(["watch", "GET", "POST", "process", "reset"]);

describe("createObservedCollector", () => {
  it("reports a channel as null until the boundary reaches it, and counts it from then on", () =>
    hegel.test((tc) => {
      const calls = tc.draw(gs.arrays(call, { maxSize: 20 }));
      const observed = createObservedCollector();
      for (const each of calls) {
        if (each === "watch") observed.watchHttp();
        else if (each === "process") observed.startProcess()({ command: ["x"], cwd: "/", exit_code: 0, duration_ms: 1 });
        else if (each === "reset") observed.reset();
        else observed.record(each);
      }
      const boundary = calls.slice(calls.lastIndexOf("reset") + 1);
      const reached = boundary.some((each) => each === "watch" || each === "GET" || each === "POST");
      const processes = boundary.filter((each) => each === "process").length;
      expect(observed.snapshot()).toEqual({
        http_reads: reached ? boundary.filter((each) => each === "GET").length : null,
        http_writes: reached ? boundary.filter((each) => each === "POST").length : null,
        processes:
          processes === 0
            ? null
            : Array.from({ length: processes }, () => ({ command: ["x"], cwd: "/", exit_code: 0, duration_ms: 1 })),
      });
    }));

  it("keeps a watched channel with no request at 0", () => {
    const observed = createObservedCollector();
    observed.watchHttp();
    expect(observed.snapshot()).toEqual({ http_reads: 0, http_writes: 0, processes: null });
  });
});
