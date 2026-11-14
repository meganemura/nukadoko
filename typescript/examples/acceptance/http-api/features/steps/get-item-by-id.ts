import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "GET /items/<id> for a literal id",
  pattern: "I request item {id:int}",
  args: z.object({ id: z.number().describe("The id in the path") }),
  returns: z.object({
    status: z.number().describe("HTTP status"),
    body: z.unknown().describe("The parsed JSON response"),
  }),
  mutates: false,
  async run({ baseURL }, { id }) {
    const res = await fetch(`${baseURL}/items/${id}`);
    return { status: res.status, body: await res.json() };
  },
});
