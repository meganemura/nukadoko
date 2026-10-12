import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "bad-int-transform {v:int}",
  description: "Capture {v:int} against z.string().transform((s) => s.length)",
  args: z.object({ v: z.string().transform((s) => s.length) }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
