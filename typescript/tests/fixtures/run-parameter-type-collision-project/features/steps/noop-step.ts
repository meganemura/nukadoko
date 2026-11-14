import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "nothing happens",
  description: "Never reached: buildStepBindings() fails before any pickle executes",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run() {
    return {};
  },
});
