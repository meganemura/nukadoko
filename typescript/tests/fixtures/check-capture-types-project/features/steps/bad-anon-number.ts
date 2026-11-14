import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "bad-anon-number {v:}",
  description: "Capture {v:} against z.number()",
  args: z.object({ v: z.number() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
