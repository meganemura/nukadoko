import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// The literal "(north)" is left unescaped, so cucumber-expressions reads it
// as optional text and the pattern never matches a line that has the parens.
export default defineStep({
  pattern: "the wall (north) is painted {c:color}",
  description: "Paint the wall",
  args: z.object({ c: z.string() }),
  returns: z.object({}),
  async run() {
    return {};
  },
});
