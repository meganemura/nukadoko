import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Attaches evidence under the name it is given, then calls the program,
// so the record directory would also hold the step's program-log.txt.
export default defineStep({
  pattern: "the step attaches evidence named {name:string}",
  description: "attach a file named as given, then GET /fast",
  args: z.object({ name: z.string() }),
  returns: z.object({}),
  mutates: false,
  async run({ baseURL, evidence }, args) {
    await evidence.attach(args.name, "the step's own evidence\n");
    await (await fetch(new URL("/fast", baseURL))).text();
    return {};
  },
});
