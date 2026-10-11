import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Never touches the broken fixtures in nukadoko.config.ts. This project
// exists so `nuka check` reports those definitions, not a step's own usage.
export default defineStep({
  pattern: "nothing happens",
  description: "A trivial step, unrelated to this project's own fixtures",
  args: z.object({}),
  returns: z.object({}),
  mutates: false,
  run() {
    return {};
  },
});
