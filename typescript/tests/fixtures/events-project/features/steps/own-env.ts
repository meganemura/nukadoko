import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// What a step's own code could find of the events file: the variables of
// its process whose value names a file nukadoko made for events.
export default defineStep({
  pattern: "the step reads its own env",
  description: "name the variables of the step's own process that point at an events file",
  args: z.object({}),
  returns: z.object({ named: z.array(z.string()) }),
  mutates: false,
  async run() {
    const inlets = path.join(os.tmpdir(), "nukadoko-events-");
    return { named: Object.entries(process.env).flatMap(([name, value]) => (value?.startsWith(inlets) === true ? [name] : [])) };
  },
});
