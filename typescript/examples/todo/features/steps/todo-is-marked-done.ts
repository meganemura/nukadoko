import { defineStep, z } from "nukadoko";

// GET /todos, read in a Then. observe reports each todo's state in the
// sentence's own words ("done" or "open") instead of the app's `done` flag,
// because a claim may compare with a literal only when the sentence states
// it, and "is marked done" states the word, not `true`. The claim then
// compares that word with the one the line captured, so the record shows
// both, and a todo the list does not hold breaks the claim instead of
// passing over nothing.
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
