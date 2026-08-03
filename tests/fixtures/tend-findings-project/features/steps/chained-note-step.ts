import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createWidget from "./create-widget.js";

// The "used from" counterexample to orphan-from-step.ts: this pattern has
// no capture at all, so the one line binding it (features/tending.feature)
// leaves `id` unfilled by anything but `from` — `from.id` genuinely fires
// here, and `nuka tend` must stay silent about it.
export default defineStep({
  pattern: "the widget is finalized",
  description: "Finalize the widget created earlier in this scenario",
  rationale: "Deliberately takes no capture so from.id is this step's only source for id, exercising the from-unused finding's negative case",
  args: z.object({ id: z.string().describe("the widget's id, filled by from") }),
  returns: z.object({ finalized: z.boolean().describe("always true") }),
  from: { id: [createWidget, "id"] },
  async run() {
    return { finalized: true };
  },
});
