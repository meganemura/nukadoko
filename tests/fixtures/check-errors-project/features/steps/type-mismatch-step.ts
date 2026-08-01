import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers: capture-type-mismatch ({int} coerces to number, but the args
// schema declares "value" as a string).
export default defineStep({
  pattern: "a type mismatch of {value:int}",
  description: "d",
  args: z.object({ value: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
