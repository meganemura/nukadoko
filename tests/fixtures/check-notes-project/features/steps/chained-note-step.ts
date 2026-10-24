import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createWidget from "./create-widget.js";

// The "used from" counterexample to orphan-from-step.ts: this pattern has
// no capture at all, so the one line binding it (features/notes.feature)
// leaves `id` unfilled by anything but `from` — `from.id` genuinely fires
// here, and `nuka check` must stay silent about it.
export default defineStep({
  pattern: "the widget is finalized",
  description: "Finalize the widget created earlier in this scenario",
  args: z.object({ id: z.string().describe("the widget's id, filled by from") }),
  returns: z.object({ finalized: z.boolean().describe("always true") }),
  from: { id: [createWidget, "id"] },
  async run() {
    return { finalized: true };
  },
});
