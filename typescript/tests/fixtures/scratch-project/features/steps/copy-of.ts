import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a copy of {source:string} is made",
  description: "Copies a project directory into a scratch directory, and makes one empty directory beside it",
  args: z.object({ source: z.string() }),
  returns: z.object({ copy: z.string(), empty: z.string(), copied: z.boolean() }),
  async run({ scratch }, args) {
    const copy = await scratch.copy(args.source);
    const empty = scratch.dir("empty");
    return { copy, empty, copied: existsSync(path.join(copy, "hello.txt")) };
  },
});
