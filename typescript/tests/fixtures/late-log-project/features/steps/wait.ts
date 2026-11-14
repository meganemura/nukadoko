import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Sends nothing, and lasts until the slow request's last line was written.
export default defineStep({
  pattern: "the step waits",
  description: "wait 600 ms",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return {};
  },
});
