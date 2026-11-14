import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Create a todo via POST /todos; a part with no pattern of its own",
  args: z.object({ title: z.string().describe("The title of the todo to create") }),
  returns: z.object({
    id: z.string().describe("The id the server assigned"),
    title: z.string().describe("The title as the server stored it"),
    done: z.boolean().describe("Whether the todo is done"),
  }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.post("/todos", { data: { title: args.title } });
    return res.json();
  },
});
