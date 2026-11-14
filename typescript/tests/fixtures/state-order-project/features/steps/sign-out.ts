import { defineStep, z } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "{person:word} signs out",
  description: "Sign out from the account menu",
  args: z.object({ person: z.string() }),
  requires: [["signed-in", "person"]],
  ends: [["signed-in", "person"]],
  run() {},
});
