import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "{count:number} items are added",
  description: "A pattern whose parameter type is not registered",
  args: z.object({ count: z.number() }),
  returns: z.object({}),
  mutates: true,
  async run() {
    return {};
  },
});
