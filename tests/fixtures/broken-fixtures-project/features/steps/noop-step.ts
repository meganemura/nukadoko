import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Never touches any of nukadoko.config.ts's own broken fixtures — this
// project exists to exercise `nuka check`'s fixture-*definition* findings,
// which are unconditional, not to exercise any step's own usage of them.
export default defineStep({
  pattern: "nothing happens",
  description: "A trivial step, unrelated to this project's own broken fixtures",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run() {
    return {};
  },
});
