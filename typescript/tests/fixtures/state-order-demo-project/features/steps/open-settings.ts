import { defineStep, z } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "{person:word} opens the settings page",
  description: "Open the settings page from the account menu",
  args: z.object({ person: z.string().describe("The person whose settings open") }),
  mutates: false,
  requires: [["signed-in", "person"]],
  run() {},
});
