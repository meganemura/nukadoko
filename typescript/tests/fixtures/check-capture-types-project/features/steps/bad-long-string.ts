import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "bad-long-string {v:long}",
  description: "Capture {v:long} against z.string()",
  args: z.object({ v: z.string() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
