import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "bad-int-boolean {v:int}",
  description: "Capture {v:int} against z.boolean()",
  args: z.object({ v: z.boolean() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
