import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the export finishes",
  description: "Wait for the export job to finish",
  args: z.object({}),
  returns: z.object({ done: z.boolean() }),
  mutates: false,
  timeout: 30000,
  async run() {
    return { done: true };
  },
});
