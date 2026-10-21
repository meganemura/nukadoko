import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import {
  collectDeclaredVsObserved,
  renderDeclaredVsObserved,
  type ComparedStep,
} from "../src/report/summary/declared-vs-observed.js";
import type { ObservedHttp, ProcessEntry } from "../src/record/types.js";

const observedHttp = gs.oneOf<ObservedHttp>(
  gs.just<ObservedHttp>({ http_reads: null, http_writes: null }),
  gs
    .tuples(gs.integers({ minValue: 0, maxValue: 3 }), gs.integers({ minValue: 0, maxValue: 3 }))
    .map(([reads, writes]): ObservedHttp => ({ http_reads: reads, http_writes: writes })),
);
const step = gs
  .tuples(gs.sampledFrom([true, false, null] as const), observedHttp, gs.integers({ minValue: 0, maxValue: 99 }))
  .map(
    ([mutates, http, id]): ComparedStep => ({
      scenarioName: `scenario ${id}`,
      stepText: `step ${id}`,
      stepRecord: { mutates, observed: { ...http, processes: null } },
    }),
  );

function processWith(files: ProcessEntry["files"], cwd = "/project"): ProcessEntry {
  return { command: ["tool"], cwd, exit_code: 0, duration_ms: 1, ...(files === undefined ? {} : { files }) };
}

function readOnlyStep(processes: ProcessEntry[], http: ObservedHttp = { http_reads: null, http_writes: null }): ComparedStep {
  return { scenarioName: "a report is built", stepText: "the report is built", stepRecord: { mutates: false, observed: { ...http, processes } } };
}

describe("the file channel", () => {
  it("lists a read-only step whose process changed a file", () => {
    const result = collectDeclaredVsObserved([
      readOnlyStep([processWith({ added: ["out/", "out/report.txt"], changed: ["cache.json"], removed: [] })]),
    ]);
    expect(result.unobservedReadOnlyCount).toBe(0);
    expect(renderDeclaredVsObserved(result)[5]).toBe(
      `- "the report is built" (scenario "a report is built"): declared mutates: false, observed 3 file changes (added /project/out/, added /project/out/report.txt, changed /project/cache.json)`,
    );
  });

  it("names the count past three changes and joins HTTP writes and file changes", () => {
    const result = collectDeclaredVsObserved([
      readOnlyStep([processWith({ added: ["a", "b", "c", "d"], changed: [], removed: ["e"] })], { http_reads: 0, http_writes: 1 }),
    ]);
    expect(renderDeclaredVsObserved(result)[5]).toBe(
      `- "the report is built" (scenario "a report is built"): declared mutates: false, observed 1 write and 5 file changes (added /project/a, added /project/b, added /project/c, and 2 more in its step record)`,
    );
  });

  it("counts a step compared when its process changed nothing", () => {
    const result = collectDeclaredVsObserved([readOnlyStep([processWith({ added: [], changed: [], removed: [] })])]);
    expect(result).toMatchObject({ mismatches: [], unobservedReadOnlyCount: 0 });
  });

  it("counts a step unobserved when its process files were not measured or not recorded", () => {
    const result = collectDeclaredVsObserved([
      readOnlyStep([processWith({ unmeasured: "more than 20000 entries under the working directory" })]),
      readOnlyStep([processWith(undefined)]),
    ]);
    expect(result).toMatchObject({ mismatches: [], unobservedReadOnlyCount: 2 });
  });
});

describe("collectDeclaredVsObserved", () => {
  it("compares a read-only step only when an HTTP channel was observed", () =>
    hegel.test((tc) => {
      const steps = tc.draw(gs.arrays(step, { maxSize: 12 }));
      const result = collectDeclaredVsObserved(steps);
      const readOnly = steps.filter((entry) => entry.stepRecord.mutates === false);
      expect(result.unobservedReadOnlyCount).toBe(
        readOnly.filter((entry) => entry.stepRecord.observed.http_writes === null).length,
      );
      expect(result.mismatches).toEqual(
        readOnly
          .filter((entry) => (entry.stepRecord.observed.http_writes ?? 0) > 0)
          .map((entry) => ({
            scenarioName: entry.scenarioName,
            stepText: entry.stepText,
            writes: entry.stepRecord.observed.http_writes,
            fileChanges: [],
          })),
      );
      expect(result.compatStepCount).toBe(steps.filter((entry) => entry.stepRecord.mutates === null).length);
    }));

  it("names one unobserved read-only step in the singular", () => {
    const lines = renderDeclaredVsObserved(
      collectDeclaredVsObserved([
        {
          scenarioName: "a total is read",
          stepText: "the total is fetched",
          stepRecord: { mutates: false, observed: { http_reads: null, http_writes: null, processes: null } },
        },
      ]),
    );
    expect(lines).toEqual([
      "",
      "## Declared vs observed",
      "",
      "No step declared `mutates: false` and was measured making a write or changing a file.",
      "",
      "1 step that declared `mutates: false` reached no HTTP channel nukadoko observes (`request`, `page`, `context`, `pageAs`) and ran no process through `runCommand` whose files were measured, so nothing was compared for it.",
    ]);
  });
});
