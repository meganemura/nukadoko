import { describe, expect, it } from "vitest";
import type { CountedGroup } from "../src/execution-events/counted.js";
import type { RunScenario, RunStep } from "../src/record/run-result.js";
import { undeclaredWriteFindings } from "../src/run/undeclared-writes.js";

// Responsibility: which executions the `undeclared-write` note names
// (src/run/undeclared-writes.ts): a step of head's that declares
// `mutates: false` and whose trace holds a persisted write to state, once
// per step line of a scenario and environment however many times
// `--repeat` ran it; never a step that declares it writes, a compat step,
// or a base or old world's step.

const SCORES: readonly CountedGroup[] = [{ kind: "db", fields: { op: "insert", table: "scores" }, lines: 1 }];

const step = (traceId: string, mutates: boolean | null): RunStep =>
  ({ line: 4, text: 'the client gets "/after"', step: "get", status: "passed", step_record_id: `s-${traceId}`, record: `steps/s-${traceId}`, mutates, observed: { events: { trace_id: traceId } } }) as unknown as RunStep;

const scenario = (steps: readonly RunStep[], over: Partial<RunScenario> = {}): RunScenario =>
  ({ scenario_record_id: "scn", feature: "features/a.feature", line: 3, scenario: "a read", environment: "default", status: "passed", steps, hooks: [], ...over }) as unknown as RunScenario;

describe("the undeclared-write note", () => {
  const writes = new Map<string, readonly CountedGroup[]>([
    ["t-read", SCORES],
    ["t-again", SCORES],
    ["t-write", SCORES],
    ["t-compat", SCORES],
    ["t-base", SCORES],
  ]);
  const notes = (scenarios: readonly RunScenario[], named = false) => undeclaredWriteFindings(scenarios, (traceId) => writes.get(traceId), { named });

  it("names a step that declares mutates: false and committed a write to state, once for the runs of --repeat", () => {
    const found = notes([scenario([step("t-read", false)]), scenario([step("t-again", false)])]);
    expect(found).toEqual([
      {
        severity: "note",
        code: "undeclared-write",
        file: "features/a.feature",
        line: 4,
        message: "a read: the step at line 4, get, declares mutates: false, and its trace holds writes the program committed to tables that hold state, 1 line: db insert into scores",
        fix: expect.stringContaining("Declare mutates: true"),
      },
    ]);
    expect(notes([scenario([step("t-read", false)], { environment: "slow" })], true)[0]!.message).toMatch(/^a read \(slow\): /);
  });

  it("names no step that declares it writes, no compat step, no step of another tree, and no step with no persisted write to state", () => {
    expect(notes([scenario([step("t-write", true), step("t-compat", null), step("t-none", false)])])).toEqual([]);
    expect(notes([scenario([step("t-base", false)], { world: "base" })])).toEqual([]);
  });
});
