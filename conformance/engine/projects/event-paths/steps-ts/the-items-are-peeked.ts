import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Look at the items, which records a visit",
  pattern: "the items are peeked",
  args: z.object({}),
  returns: z.object({ status: z.number().describe("The status the API answered") }),
  mutates: true,
  async run({ request }) {
    const response = await request.fetch("/peek", { method: "POST" });
    return { status: response.status() };
  },
});
