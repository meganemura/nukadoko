import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";

export default defineStep({
  description: "Create an item through the API so a later step can read it",
  pattern: "an item named {name:string} exists",
  args: z.object({ name: z.string().describe("The item's name") }),
  returns: z.object({ id: z.number().describe("The id the API assigned") }),
  async run({ server }, { name }) {
    const res = await fetch(`${server.url}/items`, { method: "POST", body: JSON.stringify({ name }) });
    assert.equal(res.status, 201, `creating "${name}": status`);
    const item = (await res.json()) as { id: number };
    return { id: item.id };
  },
});
