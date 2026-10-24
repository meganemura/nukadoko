import { defineStep, z } from "nukadoko";

// GET /todos, read in a Then. observe returns every title the list holds,
// and the claim says the title the sentence names is one of them, so the
// title to look for stays in the feature file and the judging stays with
// nukadoko. The claim record keeps the whole list it read, so a broken
// claim shows what the list held instead of only that the title was absent.
export default defineStep({
  pattern: "the todo list includes {title:string}",
  description: "A todo with this title is present in GET /todos",
  args: z.object({ title: z.string().describe("The title expected to be present") }),
  async observe({ request }) {
    const res = await request.get("/todos");
    const todos = (await res.json()) as Array<{ title?: string }>;
    return { titles: todos.map((todo) => todo.title) };
  },
  claims: [{ actual: "titles", compare: "has-item", expected: "title" }],
});
