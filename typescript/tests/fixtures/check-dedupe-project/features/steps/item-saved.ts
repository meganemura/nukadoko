import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the item is saved",
  description: "A step that runs, bound in Then position, so then-without-claims fires",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run() {
    return {};
  },
});
