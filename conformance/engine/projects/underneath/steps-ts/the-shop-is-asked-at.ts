import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Ask the shop at a path, whatever it answers",
  pattern: "the shop is asked at {path:string}",
  args: z.object({ path: z.string().describe("The path under /ask") }),
  returns: z.object({ status: z.number().describe("The status the shop answered") }),
  mutates: false,
  async run({ request }, { path }) {
    const response = await request.fetch(path, { method: "POST" });
    return { status: response.status() };
  },
});
