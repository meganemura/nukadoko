import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the todo titled {title:string} is marked {state:word}",
  description: "The todo with this title has the state the line names in GET /todos",
  args: z.object({
    title: z.string().describe("The title of the todo to read"),
    state: z.string().describe('The state the todo is expected to have: "done" or "open"'),
  }),
  async observe({ request }) {
    const res = await request.get("/todos");
    const todos = (await res.json()) as Array<{ title?: string; done?: boolean }>;
    return { todos: todos.map((todo) => ({ title: todo.title ?? "", state: todo.done === true ? "done" : "open" })) };
  },
  claims: [
    {
      actual: "todos",
      each: {
        where: [{ actual: "title", compare: "equal", expected: "title" }],
        claims: [{ actual: "state", compare: "equal", expected: "state" }],
      },
    },
  ],
});
