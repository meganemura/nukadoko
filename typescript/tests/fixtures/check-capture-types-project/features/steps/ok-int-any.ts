import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-int-any {v:int}",
  description: "Capture {v:int} against z.any()",
  args: z.object({ v: z.any() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
