import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import countAtoms from "./count-atoms.js";

export default defineStep({
  description: "Double the atoms (from count-atoms, or --use)",
  args: z.object({ total: z.bigint() }),
  returns: z.object({ doubled: z.bigint() }),
  from: { total: [countAtoms, "total"] },
  async run({}, args) {
    return { doubled: args.total * 2n };
  },
});
