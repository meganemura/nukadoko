import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// "empty" states the literal "", so the claim compares with a value the
// sentence names. An unset BANNER reads as null, which is never equal to a
// string, so the claim breaks there too.
export default defineStep({
  pattern: "the banner is not empty",
  description: "Check that the BANNER env value is set and not empty",
  args: z.object({}),
  observe({ env }) {
    return { banner: env.BANNER ?? null };
  },
  claims: [{ actual: "banner", compare: "not-equal", expected: { literal: "" } }],
});
