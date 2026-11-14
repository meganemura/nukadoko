import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// `evidence.path(name)` alone, with nothing ever written to the returned
// path, must contribute nothing to the step record.
export default defineStep({
  pattern: "a step allocates a path but never writes to it",
  description: "Calls evidence.path once, writes nothing",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ evidence }) {
    evidence.path("never-written.csv");
    return { ok: true };
  },
});
