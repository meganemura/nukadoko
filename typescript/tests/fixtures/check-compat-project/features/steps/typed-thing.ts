import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// A plain, well-formed typed step mixed alongside compat ones, proving the
// two kinds coexist in the vocabulary without any spurious interaction.
export default defineStep({
  pattern: "a typed thing {name:string} exists",
  description: "d",
  args: z.object({ name: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
