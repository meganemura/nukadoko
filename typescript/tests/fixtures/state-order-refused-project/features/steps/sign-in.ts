import { defineStep, z } from "../../nukadoko-shim.js";

// The key is misspelled on purpose. tsc refuses it, and a project that
// never type-checks its step files learns it from nuka check instead.
export default defineStep({
  pattern: "{person:word} signs in",
  description: "Sign in with the person's test account",
  args: z.object({ person: z.string() }),
  gives: [["signed-in", "persn"]] as never,
  run() {},
});
