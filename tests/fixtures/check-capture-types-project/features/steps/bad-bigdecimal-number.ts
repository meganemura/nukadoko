import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "bad-bigdecimal-number {v:bigdecimal}",
  description: "Capture {v:bigdecimal} against z.number()",
  args: z.object({ v: z.number() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
