import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import {
  collectDeclaredVsObserved,
  renderDeclaredVsObserved,
  type ComparedStep,
} from "../src/report/summary/declared-vs-observed.js";
import type { ObservedHttp } from "../src/record/types.js";

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
      "No step declared `mutates: false` and was measured making a write.",
      "",
      "1 step that declared `mutates: false` reached no HTTP channel nukadoko observes (`request`, `page`, `context`, `pageAs`), so nothing was compared for it.",
    ]);
  });
});
