import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the following todos are added",
  description: "POST /todos once per table row and return the titles created",
  args: z.object({
    todos: z
      .array(z.array(z.string()))
      .describe("The data table's rows, one todo per row, the title in the first cell"),
  }),
  returns: z.object({ created: z.array(z.string()).describe("The titles the server stored, in row order") }),
  mutates: true,
  async run({ request }, args) {
    const created: string[] = [];
    for (const row of args.todos) {
      const res = await request.post("/todos", { data: { title: row[0] } });
      const todo = (await res.json()) as { title?: string };
      created.push(todo.title as string);
    }
    return { created };
  },
});
