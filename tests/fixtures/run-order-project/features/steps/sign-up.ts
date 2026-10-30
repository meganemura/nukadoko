import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "{name:string} signs up",
  description: "POST /accounts/<name> to the world's program",
  args: z.object({ name: z.string() }),
  returns: z.object({ status: z.number().int() }),
  mutates: true,
  async run({ request }, { name }) {
    const response = await request.post(`/accounts/${encodeURIComponent(name)}`);
    return { status: response.status() };
  },
});
