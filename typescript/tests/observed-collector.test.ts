import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createObservedCollector } from "../src/context/observed.js";
import { createEmptyTempDir, removeTempDir } from "./helpers/fixtures.js";

type Call = "process" | "reset";

const call = gs.sampledFrom<Call>(["process", "reset"]);

describe("createObservedCollector", () => {
  it("reports processes as null until the boundary starts one, and lists each from then on", () =>
    hegel.test((tc) => {
      const calls = tc.draw(gs.arrays(call, { maxSize: 20 }));
      const observed = createObservedCollector();
      for (const each of calls) {
        if (each === "process") observed.startProcess()({ command: ["x"], cwd: "/", exit_code: 0, duration_ms: 1 });
        else observed.reset();
      }
      const boundary = calls.slice(calls.lastIndexOf("reset") + 1);
      const processes = boundary.filter((each) => each === "process").length;
      expect(observed.snapshot()).toEqual({
        processes:
          processes === 0
            ? null
            : Array.from({ length: processes }, () => ({ command: ["x"], cwd: "/", exit_code: 0, duration_ms: 1 })),
        http: null,
        files: null,
        unmeasured: [],
      });
    }));
});

const entry = { command: ["x"], cwd: "/", exit_code: 0, duration_ms: 1 };

describe("createObservedCollector process output", () => {
  // Hooks of one scenario share an evidence directory, and each hook's
  // boundary counts its processes from 1 again.
  it("keeps every non-empty stream in a file of its own, never replacing one, across collectors that share a directory", () =>
    hegel.testAsync(
      async (tc) => {
        const outputs = tc.draw(
          gs.arrays(gs.tuples(gs.integers({ minValue: 0, maxValue: 2 }), gs.text({ alphabet: "ab\n", maxSize: 6 }), gs.text({ alphabet: "cd", maxSize: 6 })), {
            maxSize: 8,
          }),
        );
        const dir = await createEmptyTempDir();
        try {
          const collectors = [0, 1, 2].map(() => createObservedCollector({ outputDir: () => dir }));
          for (const [which, stdout, stderr] of outputs) collectors[which]!.startProcess()(entry, { stdout, stderr });
          const named = collectors.flatMap((collector) => collector.snapshot().processes ?? []);
          const kept = named.flatMap((each) => [each.stdout, each.stderr].filter((name): name is string => name !== undefined));
          expect(new Set(kept).size).toBe(kept.length);
          expect(readdirSync(dir).sort()).toEqual([...kept].sort());
          const written = kept.map((name) => readFileSync(path.join(dir, name), "utf8")).sort();
          const printed = outputs.flatMap(([, stdout, stderr]) => [stdout, stderr]).filter((text) => text !== "").sort();
          expect(written).toEqual(printed);
        } finally {
          await removeTempDir(dir);
        }
      },
      { testCases: 25 },
    ));

  it("writes a loaded secret in the output as its token", async () => {
    const dir = await createEmptyTempDir();
    try {
      const observed = createObservedCollector({ outputDir: () => dir, secrets: [{ name: "TOKEN", value: "s3cret-value" }] });
      observed.startProcess()(entry, { stdout: "token=s3cret-value", stderr: "" });
      expect(observed.snapshot().processes).toEqual([{ ...entry, stdout: "process-1.stdout.txt" }]);
      expect(readFileSync(path.join(dir, "process-1.stdout.txt"), "utf8")).toBe("token={{secret.TOKEN}}");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("keeps no output without a directory, so the entry names no file", () => {
    const observed = createObservedCollector();
    observed.startProcess()(entry, { stdout: "out", stderr: "err" });
    expect(observed.snapshot().processes).toEqual([entry]);
  });
});

describe("a boundary's processes, as its trace states them", () => {
  const ending = gs.sampledFrom(["ended", "running", "no group", "still running"] as const);

  it("are none until one starts, ended once each closed with its group empty, and unbounded otherwise", () =>
    hegel.test((tc) => {
      const ends = tc.draw(gs.arrays(ending, { maxSize: 6 }));
      const observed = createObservedCollector({ trace: { prefix: "4bf92f35", origin: "http://127.0.0.1:1" } });
      for (const end of ends) {
        const finish = observed.startProcess();
        observed.processTraceparent?.();
        if (end === "still running") continue;
        finish({ command: ["x"], cwd: "/", exit_code: 0, duration_ms: 1, ...(end === "no group" ? {} : { group: end }) });
      }
      const trace = observed.boundaryTrace()!;
      expect(trace.processes).toBe(ends.length === 0 ? "none" : ends.every((end) => end === "ended") ? "ended" : "unbounded");
      // A slice waits for the lines of a process given the step's trace.
      expect(trace.lastStampAt !== undefined).toBe(ends.length > 0);
    }));
});
