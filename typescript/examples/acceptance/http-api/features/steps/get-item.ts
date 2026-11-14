import { defineStep, z } from "nukadoko";
import anItemExists from "./an-item-exists.ts";

export default defineStep({
  description: "GET /items/<id> for the item an earlier step created",
  pattern: "I request that item",
  args: z.object({ id: anItemExists.returns.shape.id }),
  from: { id: [anItemExists, "id"] },
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
