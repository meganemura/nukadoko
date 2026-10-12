import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  patterns: ["a note {text:string} is taken"],
  description: "Return the note text",
  args: z.object({ text: z.string() }),
  returns: z.object({ text: z.string() }),
  mutates: false,
  async run({}, args) {
    return { text: args.text };
  },
});
