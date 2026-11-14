import { z } from "zod";
import { defineStep, type Step } from "../../nukadoko-shim.js";
import cycleA from "./cycle-a.js";

// The other half of the cycle cycle-a.ts starts. Declares cycle-a as a part
// (one real edge), then tries to close the loop by assigning cycle-a's
// `parts` to point back here. defineStep freezes the step it returns, so the
// assignment throws when this file is imported, and nuka check reports
// step-file-import-failed for this file: a step file cannot build a parts
// cycle. A circular import between the two files cannot build one either,
// since one side's default export is still uninitialized when the other
// side reads it.
const step = defineStep({
  pattern: "cycle step b runs",
  description: "the other half of a parts cycle, on purpose, for nuka check to find",
  args: z.object({}),
  returns: z.object({}),
  parts: [cycleA],
  async run() {
    return {};
  },
});

(cycleA as unknown as { parts: Step[] }).parts = [step];

export default step;
