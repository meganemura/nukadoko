import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The one upstream in this fixture — every consumer below either chains off
// it correctly (archive-cart.ts, proving a genuine `from` chain still
// renders once the malformed-entry check exists) or names a candidate
// producer with a malformed value on purpose (bad-string.ts, bad-object.ts).
export default defineStep({
  pattern: "a cart is opened",
  description: "Open a cart and return its id",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  async run() {
    return { id: "c-1" };
  },
});
