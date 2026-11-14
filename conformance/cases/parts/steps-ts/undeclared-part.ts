import { defineStep, z } from "nukadoko";
import createTodo from "./parts/create-todo.ts";

export default defineStep({
  pattern: "a todo titled {title:string} is added without declaring its part",
  description: "Calls a part that parts does not declare, which call refuses",
  args: z.object({ title: z.string().describe("The title of the todo") }),
  mutates: true,
  parts: [],
  async run({ call }, args) {
    await call(createTodo, { title: args.title });
    return {};
  },
});
