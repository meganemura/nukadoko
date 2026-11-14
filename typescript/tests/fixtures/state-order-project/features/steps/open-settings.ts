import { defineStep, z } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "{person:word} opens the settings page",
  description: "Open the settings page from the account menu",
  args: z.object({ person: z.string() }),
  returns: z.object({ heading: z.string() }),
  mutates: false,
  requires: [["signed-in", "person"]],
  run({}, { person }) {
    return { heading: `Settings for ${person}` };
  },
});
