import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the step fails",
  description: "Throws, so the scenario fails after a scratch directory was made",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    throw new Error("this step always fails");
  },
});
