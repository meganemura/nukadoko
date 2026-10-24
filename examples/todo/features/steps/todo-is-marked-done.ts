import { defineStep, z } from "nukadoko";

// GET /todos, read in a Then. observe returns the titles of the todos that
// are done, and the claim says the title the sentence names is one of them.
// It returns titles rather than the todo's `done` flag because a claim may
// compare with a literal only when the sentence states it, and "is marked
// done" does not say `true`. It checks `done` where todo-list-includes
// checks presence, so a scenario can state either claim on its own line.
export default defineStep({
  pattern: "the todo titled {title:string} is marked done",
  description: "The todo with this title has done: true in GET /todos",
  args: z.object({ title: z.string().describe("The title of the todo expected to be done") }),
  async observe({ request }) {
    const res = await request.get("/todos");
    const todos = (await res.json()) as Array<{ title?: string; done?: boolean }>;
    return { done: todos.filter((todo) => todo.done === true).map((todo) => todo.title) };
  },
  claims: [{ actual: "done", compare: "has-item", expected: "title" }],
});
