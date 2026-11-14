import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "GET /items",
  pattern: "I request the item list",
  args: z.object({}),
  returns: z.object({
    status: z.number().describe("HTTP status"),
    body: z.unknown().describe("The parsed JSON response"),
  }),
  mutates: false,
  async run({ baseURL }) {
    const res = await fetch(`${baseURL}/items`);
    return { status: res.status, body: await res.json() };
  },
});
