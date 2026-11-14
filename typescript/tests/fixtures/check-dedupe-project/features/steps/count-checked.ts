import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the count is {count:int}",
  description: "A claim step with nothing to report",
  args: z.object({ count: z.number() }),
  async observe() {
    return { counted: 0 };
  },
  claims: [{ actual: "counted", compare: "equal", expected: "count" }],
});
