import { defineStep, z } from "../../nukadoko-shim.js";

// "signed_in" is a typo for "signed-in": no step gives it.
export default defineStep({
  pattern: "{person:word} opens the preferences page",
  description: "Open the preferences page",
  args: z.object({ person: z.string() }),
  mutates: false,
  requires: [["signed_in", "person"]],
  run() {},
});
