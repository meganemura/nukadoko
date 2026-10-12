import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-bigdecimal-string {v:bigdecimal}",
  description: "Capture {v:bigdecimal} against z.string()",
  args: z.object({ v: z.string() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
