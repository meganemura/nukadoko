import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A part that mutates, called by mutates-contradiction.ts on purpose to
// contradict that step's own `mutates: false`.
export default defineStep({
  description: "a part that changes state",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run() {
    return {};
  },
});
