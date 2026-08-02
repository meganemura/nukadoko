import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Bound in Then position: `mutates: false`, so it is never rejected by the
// Then-position enforcement (unrelated to this fixture's own purpose).
export default defineStep({
  pattern: "the visitor {name:string} is greeted",
  description: "Checks that a visitor was greeted",
  args: z.object({ name: z.string() }),
  returns: z.object({ greeted: z.boolean() }),
  mutates: false,
  async run() {
    return { greeted: true };
  },
});
