import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Pure step (no HTTP, no browser): exercises `nuka do`'s "ok" and "args
// validation failed" receipt paths (the latter by calling it with args
// missing `value`).
export default defineStep({
  description: "Echo the given value back unchanged",
  args: z.object({ value: z.string() }),
  returns: z.object({ value: z.string() }),
  mutates: false,
  async run({}, args) {
    return { value: args.value };
  },
});
