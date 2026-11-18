import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Add an item through the API",
  pattern: "an item is added",
  args: z.object({}),
  returns: z.object({ status: z.number().describe("The status the API answered") }),
  mutates: true,
  async run({ request }) {
    const response = await request.fetch("/items", { method: "POST" });
    return { status: response.status() };
  },
});
