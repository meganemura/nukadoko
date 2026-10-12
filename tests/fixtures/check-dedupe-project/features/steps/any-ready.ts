import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "an {word:word} is ready",
  description: "The other step that matches the Background line",
  args: z.object({ word: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run() {
    return {};
  },
});
