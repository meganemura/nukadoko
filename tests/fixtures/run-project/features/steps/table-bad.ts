import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The named capture "a" consumes one args key, leaving *two* required keys
// ("rest", "extra") unconsumed for the attached table — the rule requires
// exactly one, so this is a binding failure at run time (written as a
// failed step record, not treated as "never began").
export default defineStep({
  pattern: "a bad table thing {a:string} exists",
  description: "Two required keys left unconsumed by a table attachment: a binding failure",
  args: z.object({
    a: z.string(),
    rest: z.array(z.array(z.string())),
    extra: z.string(),
  }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
