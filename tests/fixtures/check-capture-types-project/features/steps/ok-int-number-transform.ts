import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-int-number-transform {v:int}",
  description: "Capture {v:int} against z.number().transform((n) => String(n))",
  args: z.object({ v: z.number().transform((n) => String(n)) }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
