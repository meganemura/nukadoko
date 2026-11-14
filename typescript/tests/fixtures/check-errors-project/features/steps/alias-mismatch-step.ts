import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers: alias-key-mismatch (the two patterns bind different key sets:
// {x} vs {y}).
export default defineStep({
  patterns: ["alias one {x:string}", "alias two {y:string}"],
  description: "d",
  args: z.object({ x: z.string(), y: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
