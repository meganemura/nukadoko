import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "PATCH one todo to done: true by its id",
  args: z.object({ id: z.string().describe("The id of the todo to complete") }),
  returns: z.object({
    id: z.string().describe("The id of the todo"),
    title: z.string().describe("Its title"),
    done: z.boolean().describe("true after the PATCH"),
  }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.patch(`/todos/${args.id}`, { data: { done: true } });
    return res.json();
  },
});
