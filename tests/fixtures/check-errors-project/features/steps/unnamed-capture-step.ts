import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers: unnamed-capture (the {string} parameter has no name).
export default defineStep({
  pattern: "an unnamed {string} thing",
  description: "d",
  args: z.object({ value: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
