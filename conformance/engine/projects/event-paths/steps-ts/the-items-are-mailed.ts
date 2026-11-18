import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Mail the items, which enqueues a job",
  pattern: "the items are mailed",
  args: z.object({}),
  returns: z.object({ status: z.number().describe("The status the API answered") }),
  mutates: true,
  async run({ request }) {
    const response = await request.fetch("/mail", { method: "POST" });
    return { status: response.status() };
  },
});
