import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  description: "A part that finishes at once",
  args: z.object({}),
  returns: z.object({ order: z.string() }),
  async run() {
    return { order: "fast" };
  },
});
