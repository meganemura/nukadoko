import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The line states the pattern the BANNER env value must match, so the claim
// holds in both environments and breaks where BANNER is unset: an unset
// value reads as null, which is never a string. A literal from the word
// "empty" would be compared with equal alone, so "is not empty" cannot say
// this.
export default defineStep({
  pattern: "the banner matches {pattern:string}",
  description: "Check that the BANNER env value matches the pattern the line states",
  args: z.object({ pattern: z.string() }),
  observe({ env }) {
    return { banner: env.BANNER ?? null };
  },
  claims: [{ actual: "banner", compare: "matches", expected: "pattern" }],
});
