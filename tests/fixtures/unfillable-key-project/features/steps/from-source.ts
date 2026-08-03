import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The upstream half of the `from`-fills baseline below — produces an id a
// `from`-declared key can read once this step has run earlier in the same
// scenario.
export default defineStep({
  pattern: "a widget source is created",
  description: "Produce an id a from-declared key downstream can read",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  async run() {
    return { id: "src-1" };
  },
});
