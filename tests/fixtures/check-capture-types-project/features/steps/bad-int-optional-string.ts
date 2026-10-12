import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "bad-int-optional-string {v:int}",
  description: "Capture {v:int} against z.string().optional()",
  args: z.object({ v: z.string().optional() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
