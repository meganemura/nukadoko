import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `returns: z.void()`: the step record's own `result` is undefined, not null.
export default defineStep({
  pattern: "a step returns nothing",
  description: "Returns no value at all",
  args: z.object({}),
  returns: z.void(),
  mutates: false,
  async run() {},
});
