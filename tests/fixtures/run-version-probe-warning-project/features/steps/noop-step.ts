import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "nothing happens",
  description: "A trivial step; this project is only about the version probe's own failure",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run() {
    return {};
  },
});
