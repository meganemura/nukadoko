import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers: invalid-capture-key ("1abc" isn't a valid identifier).
export default defineStep({
  pattern: "an invalid key {1abc:string} thing",
  description: "d",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
