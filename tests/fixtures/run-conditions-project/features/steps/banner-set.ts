import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the banner is set",
  description: "Fail unless the BANNER env value is set",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run({ env }) {
    if (env.BANNER === undefined) throw new Error("BANNER is not set");
    return {};
  },
});
