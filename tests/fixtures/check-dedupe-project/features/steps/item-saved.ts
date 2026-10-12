import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the item is saved",
  description: "A mutating step bound in Then position, so then-mutates fires",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run() {
    return {};
  },
});
