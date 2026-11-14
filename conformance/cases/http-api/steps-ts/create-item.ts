import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "POST /items with this JSON body, verbatim",
  pattern: "I POST this body to \\/items",
  args: z.object({ body: z.string().describe("The request body, sent as-is") }),
  returns: z.object({
    status: z.number().describe("HTTP status"),
    body: z.unknown().describe("The parsed JSON response"),
  }),
  async run({ baseURL }, { body }) {
    const res = await fetch(`${baseURL}/items`, { method: "POST", body });
    return { status: res.status, body: await res.json() };
  },
});
