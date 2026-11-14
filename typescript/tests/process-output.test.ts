import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, it } from "vitest";
import { ReservedEvidenceNameError } from "../src/context/errors.js";
import { createEvidenceCollector } from "../src/context/evidence.js";
import { isProcessOutputFileName, processOutputFileName } from "../src/context/process-output.js";

// Responsibility: the names of the files that keep a process's output, and
// that `ctx.evidence` cannot take one of them from the harness.

const stream = gs.sampledFrom<"stdout" | "stderr">(["stdout", "stderr"]);

describe("process output file names", () => {
  it("recognizes every name it gives, in any case, and evidence refuses it", () =>
    hegel.test((tc) => {
      const position = tc.draw(gs.integers({ minValue: 1, maxValue: 100_000 }));
      const name = processOutputFileName(position, tc.draw(stream));
      const spelled = tc.draw(gs.booleans()) ? name.toUpperCase() : name;
      expect(isProcessOutputFileName(spelled)).toBe(true);
      const collector = createEvidenceCollector(() => "/tmp/nukadoko-unused");
      expect(() => collector.path(spelled)).toThrow(ReservedEvidenceNameError);
    }));

  it("gives each position and stream its own name", () =>
    hegel.test((tc) => {
      const [a, b] = [tc.draw(gs.integers({ minValue: 1, maxValue: 50 })), tc.draw(gs.integers({ minValue: 1, maxValue: 50 }))];
      const [s, t] = [tc.draw(stream), tc.draw(stream)];
      expect(processOutputFileName(a, s) === processOutputFileName(b, t)).toBe(a === b && s === t);
    }));

  it("leaves ordinary attachment names free", () => {
    for (const name of ["process-0.stdout.txt", "process-1.stdout.log", "process-x.stderr.txt", "process-1.txt", "stdout.txt", "process-01.stdout.txt"]) {
      expect(isProcessOutputFileName(name)).toBe(false);
    }
  });
});
