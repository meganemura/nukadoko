import { defineStep, z } from "../../nukadoko-shim.js";

// The negative path requires nothing: it is how a scenario shows what
// happens without the state.
export default defineStep({
  pattern: "{person:word} tries to open the settings page",
  description: "Go to /settings directly and return the page the browser ended up on",
  args: z.object({ person: z.string() }),
  returns: z.object({ page: z.string() }),
  mutates: false,
  run() {
    return { page: "sign-in" };
  },
});
