import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  description: "Return a scratch directory and an undescribed label",
  args: z.object({}),
  returns: z.object({
    root: z.string().describe("the scratch directory"),
    label: z.string(),
  }),
  async run() {
    return { root: "/tmp/x", label: "x" };
  },
});
