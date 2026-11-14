import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-int-union {v:int}",
  description: "Capture {v:int} against z.union([z.string(), z.number()])",
  args: z.object({ v: z.union([z.string(), z.number()]) }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
