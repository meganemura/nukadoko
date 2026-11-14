import { defineStep, z } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "{person:word} opens the home page",
  description: "Open the home page",
  args: z.object({ person: z.string() }),
  mutates: false,
  run() {},
});
