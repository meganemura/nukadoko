import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Place an order, which fails when the API refuses it",
  pattern: "an order is placed",
  args: z.object({}),
  returns: z.object({ status: z.number().describe("The status the API answered") }),
  mutates: true,
  async run({ request }) {
    const response = await request.fetch("/orders", { method: "POST" });
    if (response.status() !== 201) throw new Error(`the order was refused with ${response.status()}`);
    return { status: response.status() };
  },
});
