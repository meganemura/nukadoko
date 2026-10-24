import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "the request fixture reaches the api",
  description: "Sends one GET through the request fixture",
  args: z.object({}),
  returns: z.object({ status: z.number() }),
  mutates: false,
  async run({ request }) {
    const response = await request.get(`${process.env.CHANNELS_BASE}/api`);
    return { status: response.status() };
  },
});
