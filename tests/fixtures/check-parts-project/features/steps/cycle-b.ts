import { z } from "zod";
import { defineStep, type Step } from "../../nukadoko-shim.js";
import cycleA from "./cycle-a.js";

// The other half of the cycle cycle-a.ts starts. Declares cycle-a as a part
// (one real edge), then closes the loop by mutating cycle-a's own
// already-registered `parts` array to point back here. `Step.parts` is
// `readonly` only at the type level (src/step/define-step.ts), so this cast
// is the one way this fixture can produce a genuine two-step cycle without
// a circular import between this file and cycle-a.ts — an actual ESM cycle
// would instead throw at module evaluation (one side's default export still
// uninitialized when the other side reads it) and surface as a
// step-file-import-failed finding, not the part-cycle this fixture exists
// to exercise. Both files still evaluate once, in one shared module
// namespace (src/discover/discover-steps.ts's own header), so the `cycleA`
// this file mutates is the identical object discovery itself later
// registers under the name "cycle-a".
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
