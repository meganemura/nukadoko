import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Finishes after its sibling in the concurrent-call tests, so finish order
// differs from start order.
export default defineStep({
  description: "A part that finishes after a short delay",
  args: z.object({}),
  returns: z.object({ order: z.string() }),
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { order: "slow" };
  },
});
