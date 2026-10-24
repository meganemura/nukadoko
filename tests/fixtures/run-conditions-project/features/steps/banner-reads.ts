import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the banner reads {state:string}",
  description: "Compare the BANNER env value with the given state",
  args: z.object({ state: z.string() }),
  observe({ env }) {
    return { banner: env.BANNER ?? null };
  },
  claims: [{ actual: "banner", compare: "equal", expected: "state" }],
});
