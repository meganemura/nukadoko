import { defineStep, z } from "nukadoko";
import createTodo from "./parts/create-todo.ts";

export default defineStep({
  pattern: "a todo titled {title:string} is peeked at",
  description: "Claims to only read, but declares a part that writes",
  args: z.object({ title: z.string().describe("The title of the todo") }),
  mutates: false,
  parts: [createTodo],
  async run({ call }, args) {
    await call(createTodo, { title: args.title });
    return {};
  },
});
