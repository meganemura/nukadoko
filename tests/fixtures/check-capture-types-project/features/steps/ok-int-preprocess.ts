import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "ok-int-preprocess {v:int}",
  description: "Capture {v:int} against z.preprocess((v) => String(v), z.string())",
  args: z.object({ v: z.preprocess((v) => String(v), z.string()) }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
