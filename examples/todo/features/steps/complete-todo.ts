import { defineStep } from "nukadoko";
import { z } from "zod";

// There is no "complete a todo by title" endpoint, so this step composes two
// calls itself: GET /todos to resolve the title to an id, then PATCH that
// id's `done` to true -- the same lookup-then-act shape any real client
// needs when an API only exposes operations by id.
export default defineStep({
  pattern: "the todo titled {title:string} is completed",
  description: "Find a todo by title and PATCH it to done: true",
  args: z.object({ title: z.string() }),
  returns: z.object({ id: z.string(), title: z.string(), done: z.boolean() }),
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
