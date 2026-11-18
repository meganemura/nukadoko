import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "List the items",
  pattern: "an item is listed",
  args: z.object({}),
  returns: z.object({ status: z.number().describe("The status the API answered") }),
  mutates: false,
  async run({ request }) {
    const response = await request.fetch("/list", { method: "POST" });
    return { status: response.status() };
  },
});
