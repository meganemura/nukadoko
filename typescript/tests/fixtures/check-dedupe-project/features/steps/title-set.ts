import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a title is set",
  description: "A step with a required key that nothing on its line fills",
  args: z.object({ title: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
