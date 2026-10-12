import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-custom-number {v:custom}",
  description: "Capture {v:custom} against z.number()",
  args: z.object({ v: z.number() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
