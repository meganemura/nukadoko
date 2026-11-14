import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// See ambiguous-a.ts: the other half of the deliberate duplicate.
export default defineStep({
  pattern: "an ambiguous thing exists",
  description: "The other of two steps that both match the same text",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
