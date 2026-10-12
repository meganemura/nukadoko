import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "bad-biginteger-number {v:biginteger}",
  description: "Capture {v:biginteger} against z.number()",
  args: z.object({ v: z.number() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
