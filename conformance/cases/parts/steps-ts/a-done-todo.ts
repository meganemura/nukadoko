import { defineStep, z } from "nukadoko";
import createTodo from "./parts/create-todo.ts";
import completeById from "./parts/complete-by-id.ts";

export default defineStep({
  pattern: "a done todo titled {title:string} exists",
  description: "Create a todo and complete it, through two parts",
  args: z.object({ title: z.string().describe("The title of the todo") }),
  returns: z.object({
    id: z.string().describe("The id of the todo"),
    done: z.boolean().describe("true once completed"),
  }),
  mutates: true,
  parts: [createTodo, completeById],
  async run({ call }, args) {
    const created = await call(createTodo, { title: args.title });
    const completed = await call(completeById, { id: created.id });
    return { id: completed.id, done: completed.done };
  },
});
