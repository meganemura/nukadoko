import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Evaluate the quick reorder flag on one side",
  pattern: "the reorder is evaluated {side:string}",
  args: z.object({ side: z.string().describe("The side the program evaluates") }),
  returns: z.object({ status: z.number().describe("The status the API answered") }),
  async run({ request }, { side }) {
    const response = await request.fetch(`/reorder/${side}`, { method: "POST" });
    return { status: response.status() };
  },
});
