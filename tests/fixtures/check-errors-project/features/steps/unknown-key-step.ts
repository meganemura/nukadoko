import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Triggers: unknown-capture-key (the pattern binds "oops", which the args
// schema has no key for).
export default defineStep({
  pattern: "unknown key {oops:string} thing",
  description: "d",
  args: z.object({ other: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
