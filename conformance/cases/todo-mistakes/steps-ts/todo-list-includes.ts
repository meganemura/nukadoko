import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the todo list includes {title:string}",
  description: "A todo with this title is present in GET /todos",
  args: z.object({ title: z.string().describe("The title expected to be present") }),
  async observe({ request }) {
    const res = await request.get("/todos");
    const todos = (await res.json()) as Array<{ title?: string }>;
    return { titles: todos.map((todo) => todo.title) };
  },
  claims: [{ actual: "titles", compare: "includes-item", expected: "title" }],
});
