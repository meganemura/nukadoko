import { writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Writes a file of its own in the world's directory, where the program
// keeps its database, and asks the program to write one there too.
export default defineStep({
  pattern: "the step and the program each write a file beside the database",
  description: "write step-wrote.txt beside DB, then GET /write",
  args: z.object({}),
  returns: z.object({}),
  mutates: true,
  async run({ request }) {
    writeFileSync(path.join(path.dirname(process.env.DB!), "step-wrote.txt"), "from the step\n");
    await request.get("/write");
    return {};
  },
});
