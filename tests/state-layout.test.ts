import path from "node:path";
import { describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  doRelativeDir,
  relativeToRun,
  runRelativeDir,
  runsRelativeDir,
  scenarioRelativeDir,
  stepRecordRelativeDir,
} from "../src/record/state-layout.js";

// Responsibility: where each kind of measurement lives under the state
// directory. A run's own files stay inside its run directory, a `nuka do`
// record stays outside every run, and a run.json path resolves back to
// the file it names.

const segment = gs.text({ minSize: 1, maxSize: 12, alphabet: "abcdefghijklmnopqrstuvwxyz0123456789-" });
const stateDirGen = gs.sampledFrom([".nukadoko", "state", path.join("tmp", ".nukadoko")]);

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

describe("state layout", () => {
  it("puts a run's step records and scenario evidence inside its run directory, and a nuka do record inside none", () =>
    hegel.test((tc) => {
      const stateDir = tc.draw(stateDirGen);
      const runId = tc.draw(segment);
      const otherRunId = tc.draw(segment);
      const id = tc.draw(segment);
      const runDir = runRelativeDir(stateDir, runId);

      expect(isInside(runsRelativeDir(stateDir), runDir)).toBe(true);
      expect(isInside(runDir, stepRecordRelativeDir(stateDir, runId, id))).toBe(true);
      expect(isInside(runDir, scenarioRelativeDir(stateDir, runId, id))).toBe(true);
      const doRecord = stepRecordRelativeDir(stateDir, null, id);
      expect(isInside(doRelativeDir(stateDir), doRecord)).toBe(true);
      expect(isInside(runsRelativeDir(stateDir), doRecord)).toBe(false);
      if (otherRunId !== runId) {
        expect(isInside(runRelativeDir(stateDir, otherRunId), stepRecordRelativeDir(stateDir, runId, id))).toBe(false);
      }
    }));

  it("names a run's file relative to the run directory, and joining it back gives the file", () =>
    hegel.test((tc) => {
      const stateDir = tc.draw(stateDirGen);
      const runId = tc.draw(segment);
      const id = tc.draw(segment);
      for (const file of [stepRecordRelativeDir(stateDir, runId, id), scenarioRelativeDir(stateDir, runId, id)]) {
        const relative = relativeToRun(stateDir, runId, file);
        expect(path.isAbsolute(relative)).toBe(false);
        expect(relative.startsWith("..")).toBe(false);
        expect(path.join(runRelativeDir(stateDir, runId), relative)).toBe(file);
      }
    }));

  it("names the paths run.json and stderr show", () => {
    expect(stepRecordRelativeDir(".nukadoko", "run-1", "step-1")).toBe(path.join(".nukadoko", "runs", "run-1", "steps", "step-1"));
    expect(stepRecordRelativeDir(".nukadoko", null, "step-1")).toBe(path.join(".nukadoko", "do", "step-1"));
    expect(scenarioRelativeDir(".nukadoko", "run-1", "scn-1")).toBe(path.join(".nukadoko", "runs", "run-1", "scenarios", "scn-1"));
    expect(relativeToRun(".nukadoko", "run-1", path.join(".nukadoko", "runs", "run-1", "steps", "step-1"))).toBe(
      path.join("steps", "step-1"),
    );
  });
});
