import { defineStep } from "nukadoko";
import { z } from "zod";

// GET /todos, Then position: the same assert-don't-just-answer shape as
// todo-list-includes.ts, checking `done` instead of presence.
export default defineStep({
  pattern: "the todo titled {title:string} is marked done",
  description: "Assert the todo with this title has done: true in GET /todos",
  args: z.object({ title: z.string() }),
  returns: z.object({ done: z.boolean() }),
  mutates: false,
  async run({ request }, args) {
    const res = await request.get("/todos");
    const todos = (await res.json()) as Array<{ title?: string; done?: boolean }>;
    const match = todos.find((todo) => todo.title === args.title);
    if (!match || match.done !== true) {
      throw new Error(`todo titled "${args.title}" is not marked done`);
    }
    return { done: true };
  },
});
