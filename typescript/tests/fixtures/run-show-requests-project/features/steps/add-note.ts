import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "a note {text:string} is added",
  description: "POST /notes through ctx.request()",
  args: z.object({ text: z.string().describe("The note") }),
  mutates: true,
  async run({ request }, args) {
    await request.post("/notes", { data: { text: args.text } });
  },
});
