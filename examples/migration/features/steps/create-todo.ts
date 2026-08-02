import { defineStep } from "nukadoko";
import { z } from "zod";

// The promoted half of this suite's one producer/consumer pair
// (README.md's Stage 2): this used to be compat glue shaped exactly like
// ../steps/seed-legacy-todos.ts still is -- an untyped POST to /todos, its
// result held on `this` for a later step to dig back out. Promoting the
// *producer* first is the order migration-knowhow recommends: a consumer
// can only read a validated result once one exists, and `defineStep`'s own
// `returns` schema is what makes this step's result citable through
// `ctx.resultOf` instead of an unvalidated World read.
export default defineStep({
  pattern: "a todo titled {title:string} is created",
  description: "Create a todo via POST /todos and return the created record",
  args: z.object({ title: z.string() }),
  returns: z.object({ id: z.string(), title: z.string(), done: z.boolean() }),
  mutates: true,
  async run(ctx, args) {
    const res = await (await ctx.request()).post("/todos", { data: { title: args.title } });
    return res.json();
  },
});
