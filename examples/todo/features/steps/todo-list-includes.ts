import { defineStep } from "nukadoko";
import { z } from "zod";

// GET /todos, bound in Then position: read-only (mutates: false), and --
// unlike a step that only answers a question -- this one asserts. It throws
// when the title is absent, because a Then step that always returns `ok`
// with no way to fail proves nothing.
export default defineStep({
  pattern: "the todo list includes {title:string}",
  description: "Assert a todo with this title is present in GET /todos",
  args: z.object({ title: z.string() }),
  returns: z.object({ found: z.boolean() }),
  mutates: false,
  async run(ctx, args) {
    const res = await (await ctx.request()).get("/todos");
    const todos = (await res.json()) as Array<{ title?: string }>;
    const found = todos.some((todo) => todo.title === args.title);
    if (!found) {
      throw new Error(`no todo titled "${args.title}" in GET /todos`);
    }
    return { found };
  },
});
