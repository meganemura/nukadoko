import { defineStep, z } from "nukadoko";
import anOwner from "./an-owner.ts";
import listOfTodos from "./list-of-todos.ts";

export default defineStep({
  description: "Count the open todos, up to a limit",
  pattern: "the open todos are counted",
  args: z.object({
    todos: listOfTodos.returns.shape.todos,
    owner: z.string().optional().describe("The owner, when a line names one"),
    limit: z.number().int().default(10).describe("The most todos counted"),
  }),
  from: { todos: [listOfTodos, "todos"], owner: [anOwner, "name"] },
  returns: z.object({
    count: z.number().int().nonnegative().describe("How many todos are open"),
    owner: z.string().describe("The owner, or nobody"),
  }),
  // Keeps nothing.
  mutates: false,
  run({}, { todos, owner, limit }) {
    return { count: Math.min(limit, todos.filter((todo) => !todo.done).length), owner: owner ?? "nobody" };
  },
});
