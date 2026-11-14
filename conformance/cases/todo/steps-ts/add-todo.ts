import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "a todo titled {title:string} is added",
  description: "Create a todo via POST /todos and return the created record",
  args: z.object({ title: z.string().describe("The title of the todo to create") }),
  returns: z.object({
    id: z.string().describe("The id the server assigned"),
    title: z.string().describe("The title as the server stored it"),
    done: z.boolean().describe("Whether the todo is done; false for a new one"),
  }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.post("/todos", { data: { title: args.title } });
    return res.json();
  },
});
