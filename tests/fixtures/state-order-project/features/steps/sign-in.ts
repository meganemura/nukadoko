import { defineStep, z } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "{person:word} signs in",
  description: "Sign in with the person's test account",
  args: z.object({ person: z.string() }),
  gives: [["signed-in", "person"]],
  run() {},
});
