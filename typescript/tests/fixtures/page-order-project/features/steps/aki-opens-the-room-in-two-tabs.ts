import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Both tabs send the same GET /state in one step, so the trace id is the
// same and only the span id tells their requests apart.
export default defineStep({
  pattern: "aki opens the room in two tabs",
  description: "open /room in the scenario's tab and in a second one, and wait until each draws its state",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run({ page, context }) {
    const second = await context.newPage();
    for (const tab of [page, second]) {
      await tab.goto("/room");
      await tab.waitForFunction('document.getElementById("state").textContent === "ready"');
    }
    return {};
  },
});
