import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Discovery-only twin of the `open-cart` step the test file itself defines
// inline and actually runs through `recordStep`: `nuka
// harvest` needs a real, on-disk vocabulary entry to render a step record
// back into a feature line, but never calls `run()` to do that (only
// `pattern`/`args`/`returns` are read) — so this file's own `run` is a stub
// that is never reached, and the pattern/schemas below are kept identical
// to the test file's inline step by hand.
export default defineStep({
  pattern: "a cart is opened",
  description: "Open a new cart",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  mutates: true,
  async run() {
    throw new Error("not executed: nuka harvest reads this step's pattern/schemas only");
  },
});
