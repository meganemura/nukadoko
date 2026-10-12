import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-int-number {v:int}",
  description: "Capture {v:int} against z.number()",
  args: z.object({ v: z.number() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
