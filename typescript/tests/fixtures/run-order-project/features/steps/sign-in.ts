import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "{name:string} signs in",
  description: "POST /sessions/<name> to the world's program",
  args: z.object({ name: z.string() }),
  returns: z.object({ status: z.number().int() }),
  mutates: false,
  async run({ request }, { name }) {
    const response = await request.post(`/sessions/${encodeURIComponent(name)}`);
    return { status: response.status() };
  },
});
