import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import type { RunProbe, RunScenario } from "../src/record/run-result.js";
import { mutateCapture, probeFindings } from "../src/run/probe.js";

// Responsibility: the capture mutator and the probe notes `nuka run
// --probe` raises, as properties over any value and any run.

const capture = gs.oneOf<unknown>(gs.text(), gs.booleans(), gs.floats(), gs.integers());

describe("mutateCapture", () => {
  it("changes a string, a boolean, or a number and keeps its type", () =>
    hegel.test((tc) => {
      const value = tc.draw(capture);
      const changed = mutateCapture(value);
      if (changed === null) {
        expect(typeof value).toBe("number");
        expect(Object.is((value as number) + 1, value)).toBe(true);
        return;
      }
      expect(typeof changed.value).toBe(typeof value);
      expect(Object.is(changed.value, value)).toBe(false);
    }));

  it("probes every string and boolean", () =>
    hegel.test((tc) => {
      const value = tc.draw(gs.oneOf<unknown>(gs.text(), gs.booleans()));
      expect(mutateCapture(value)).not.toBeNull();
    }));

  it("leaves out a value of any other type", () => {
    expect([null, undefined, { a: 1 }, ["a"], 1n].map(mutateCapture)).toEqual([null, null, null, null, null]);
  });

  it("changes a string by its suffix, a number by one, a boolean by its negation", () => {
    expect([mutateCapture("Ada"), mutateCapture(11), mutateCapture(true)]).toEqual([
      { value: "Ada-probe" },
      { value: 12 },
      { value: false },
    ]);
  });
});

const probe: gs.Generator<RunProbe> = gs.sampledFrom(["passed", "failed"] as const).map((status) => ({
  line: 4,
  step: "s",
  key: "k",
  recorded: "a",
  changed: "a-probe",
  status,
}));

const scenario: gs.Generator<RunScenario> = gs
  .tuples(gs.sampledFrom(["passed", "failed"] as const), gs.arrays(probe, { maxSize: 4 }), gs.integers({ minValue: 1, maxValue: 99 }))
  .map(([status, probes, line]) => ({
    scenario_record_id: "scenario-x",
    feature: "features/a.feature",
    line,
    scenario: "a",
    environment: "default",
    status,
    started_at: "2026-10-18T00:00:00.000Z",
    finished_at: "2026-10-18T00:00:00.000Z",
    steps: [],
    hooks: [],
    probes,
  }));

describe("probeFindings", () => {
  it("raises one note per passed probe of a passed scenario, and nothing else", () =>
    hegel.test((tc) => {
      const scenarios = tc.draw(gs.arrays(scenario, { maxSize: 5 }));
      const findings = probeFindings(scenarios, { rerunFlags: () => [], named: false });
      const expected = scenarios
        .filter((entry) => entry.status === "passed")
        .flatMap((entry) => (entry.probes ?? []).filter((entry) => entry.status === "passed").map(() => entry.line));
      expect(findings.map((finding) => finding.do)).toEqual(expected.map((line) => `nuka run features/a.feature:${line} --probe`));
      expect(findings.every((finding) => finding.severity === "note" && finding.code === "then-passed-with-changed-capture")).toBe(true);
    }));

  it("names the environment and reruns in it when the run had several", () => {
    const findings = probeFindings(
      [
        {
          scenario_record_id: "scenario-x",
          feature: "features/a.feature",
          line: 3,
          scenario: "a",
          environment: "flag-off",
          status: "passed",
          started_at: "2026-10-18T00:00:00.000Z",
          finished_at: "2026-10-18T00:00:00.000Z",
          steps: [],
          hooks: [],
          probes: [{ line: 4, step: "the total is", key: "total", recorded: 3, changed: 4, status: "passed" }],
        },
      ],
      { rerunFlags: (environment) => ["--env", environment], named: true },
    );
    expect(findings.map((finding) => [finding.message, finding.do])).toEqual([
      ['step "the total is" (flag-off) passed with total 4 in place of 3', "nuka run features/a.feature:3 --probe --env flag-off"],
    ]);
  });
});
