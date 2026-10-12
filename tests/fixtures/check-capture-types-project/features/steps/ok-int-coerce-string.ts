import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-int-coerce-string {v:int}",
  description: "Capture {v:int} against z.coerce.string()",
  args: z.object({ v: z.coerce.string() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
