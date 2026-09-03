import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the todo titled {title:string} is completed",
  description: "Find a todo by title and PATCH it to done: true",
  rationale:
    "There is no \"complete a todo by title\" endpoint, so this step composes two calls itself: " +
    "GET /todos to resolve the title to an id, then PATCH that id's `done` to true. The same " +
    "lookup-then-act shape any real client needs when an API only exposes operations by id. A " +
    "step taking the id instead would push the lookup into the feature file, where a reader " +
    "has no id to write.",
  args: z.object({ title: z.string().describe("The title of the todo to complete; must already exist") }),
  returns: z.object({
    id: z.string().describe("The id of the todo that was completed"),
    title: z.string().describe("Its title, as the server returned it"),
    done: z.boolean().describe("true after the PATCH"),
  }),
  mutates: true,
  async run({ request }, args) {
    const listRes = await request.get("/todos");
    const todos = (await listRes.json()) as Array<{ id?: string; title?: string }>;
    const match = todos.find((todo) => todo.title === args.title);
    if (!match) {
      throw new Error(`no todo titled "${args.title}" to complete`);
    }
    const res = await request.patch(`/todos/${match.id}`, { data: { done: true } });
    return res.json();
  },
});
