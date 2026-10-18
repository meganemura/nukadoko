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

const probe: gs.Generator<RunProbe> = gs.sampledFrom(["passed", "caught", "not-measured"] as const).map((status) => ({
  line: 4,
  step: "s",
  text: "the value is \"a\"",
  key: "k",
  recorded: "a",
  changed: "a-probe",
  status,
  ...(status === "not-measured" ? { reason: "args-rejected" as const, message: "k: Invalid" } : {}),
}));

const scenario: gs.Generator<RunScenario> = gs
  .tuples(gs.sampledFrom(["passed", "failed"] as const), gs.arrays(probe, { maxSize: 4 }), gs.integers({ minValue: 1, maxValue: 9 }))
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

const CODES = { passed: "then-passed-with-changed-capture", "not-measured": "then-probe-not-measured" } as const;

describe("probeFindings", () => {
  it("raises one note per scenario line, step, key, and outcome, for a passed or unmeasured probe of a passed scenario", () =>
    hegel.test((tc) => {
      const scenarios = tc.draw(gs.arrays(scenario, { maxSize: 5 }));
      const findings = probeFindings(scenarios, { rerunFlags: () => [], named: false });
      const expected = [
        ...new Set(
          scenarios
            .filter((entry) => entry.status === "passed")
            .flatMap((entry) =>
              (entry.probes ?? []).flatMap((each) => (each.status === "caught" ? [] : [`nuka run features/a.feature:${entry.line} --probe ${CODES[each.status]}`])),
            ),
        ),
      ];
      expect(findings.map((finding) => `${finding.do} ${finding.code}`)).toEqual(expected);
      expect(findings.every((finding) => finding.severity === "note")).toBe(true);
    }));

  it("folds the executions of --repeat into one note that says in how many it held", () => {
    const execution = (status: "passed" | "caught") => ({
      scenario_record_id: "scenario-x",
      feature: "features/a.feature",
      line: 3,
      scenario: "a",
      environment: "default",
      status: "passed" as const,
      started_at: "2026-10-18T00:00:00.000Z",
      finished_at: "2026-10-18T00:00:00.000Z",
      steps: [],
      hooks: [],
      probes: [{ line: 4, step: "file-reads", text: 'the file reads "a"', key: "content", recorded: "a", changed: "a-probe", status }],
    });
    const findings = probeFindings([execution("passed"), execution("caught"), execution("passed")], { rerunFlags: () => [], named: false });
    expect(findings.map((finding) => finding.message)).toEqual([
      'the file reads "a": step "file-reads" passed with content "a-probe" in place of "a", in 2 of 3 executions',
    ]);
  });

  it("notes a probe that did not measure, with its reason and message", () => {
    const findings = probeFindings(
      [
        {
          scenario_record_id: "scenario-x",
          feature: "features/a.feature",
          line: 3,
          scenario: "a",
          environment: "default",
          status: "passed",
          started_at: "2026-10-18T00:00:00.000Z",
          finished_at: "2026-10-18T00:00:00.000Z",
          steps: [],
          hooks: [],
          probes: [
            {
              line: 4,
              step: "the shell answers",
              text: 'the shell answers "ok"',
              key: "answer",
              recorded: "ok",
              changed: "ok-probe",
              status: "not-measured",
              reason: "wrote",
              message: "the step ran 1 process when it ran, so it is not run again",
            },
          ],
        },
      ],
      { rerunFlags: () => [], named: false },
    );
    expect(findings).toEqual([
      {
        severity: "note",
        code: "then-probe-not-measured",
        file: "features/a.feature",
        line: 4,
        step: "the shell answers",
        message:
          'the shell answers "ok": step "the shell answers" was not probed with answer "ok-probe" (wrote): the step ran 1 process when it ran, so it is not run again',
        fix: "Read the reason in the message: a step that wrote when it ran is not run again, and a re-run that wrote is not counted; an args schema that refuses the changed value, a fixture that failed, a timeout, or a returns schema that refuses the result is corrected where the message names, or the Then is left to review.",
        do: "nuka run features/a.feature:3 --probe",
      },
    ]);
  });

  it("keeps a note apart for each reason under --repeat, with each reason's own message", () => {
    const execution = (reason: "wrote" | "timeout", message: string): RunScenario => ({
      scenario_record_id: `scenario-${reason}`,
      feature: "features/a.feature",
      line: 3,
      scenario: "a",
      environment: "default",
      status: "passed",
      started_at: "2026-10-18T00:00:00.000Z",
      finished_at: "2026-10-18T00:00:00.000Z",
      steps: [],
      hooks: [],
      probes: [{ line: 4, step: "file-reads", text: 'the file reads "a"', key: "content", recorded: "a", changed: "a-probe", status: "not-measured", reason, message }],
    });
    const findings = probeFindings(
      [execution("timeout", "Step file-reads timed out"), execution("wrote", "the probe's re-run ran 1 process, so its outcome is not used"), execution("timeout", "Step file-reads timed out")],
      { rerunFlags: () => [], named: false },
    );
    expect(findings.map((finding) => finding.message)).toEqual([
      'the file reads "a": step "file-reads" was not probed with content "a-probe" (timeout): Step file-reads timed out, in 2 of 3 executions',
      'the file reads "a": step "file-reads" was not probed with content "a-probe" (wrote): the probe\'s re-run ran 1 process, so its outcome is not used, in 1 of 3 executions',
    ]);
  });

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
          probes: [{ line: 4, step: "the total is", text: "the total is 3", key: "total", recorded: 3, changed: 4, status: "passed" }],
        },
      ],
      { rerunFlags: (environment) => ["--env", environment], named: true },
    );
    expect(findings.map((finding) => [finding.message, finding.do])).toEqual([
      ['the total is 3: step "the total is" (flag-off) passed with total 4 in place of 3', "nuka run features/a.feature:3 --probe --env flag-off"],
    ]);
  });
});
