import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Queue a job through the API",
  pattern: "a job is queued",
  args: z.object({}),
  returns: z.object({ status: z.number().describe("The status the API answered") }),
  mutates: true,
  async run({ request }) {
    const response = await request.fetch("/jobs", { method: "POST" });
    return { status: response.status() };
  },
});
