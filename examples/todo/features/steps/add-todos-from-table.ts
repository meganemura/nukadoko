import { defineStep } from "nukadoko";
import { z } from "zod";

// No named capture in this pattern, so the attached data table binds to the
// one required args key left unconsumed: `todos`, one row per title, each
// row a single-cell string[] (docs/spec.md "Typed steps": a table binds as
// string[][], no header-row convention).
export default defineStep({
  pattern: "the following todos are added",
  description: "POST /todos once per table row and return the titles created",
  args: z.object({ todos: z.array(z.array(z.string())) }),
  returns: z.object({ created: z.array(z.string()) }),
  mutates: true,
  async run({ request }, args) {
    const created: string[] = [];
    for (const row of args.todos) {
      const res = await request.post("/todos", { data: { title: row[0] } });
      // Cast, not validated here: whether this is actually a string is
      // exactly what the `returns` schema below checks. That is the whole
      // point of this example (see README.md, Part 2) -- TypeScript trusts
      // the wire contract; zod is what catches it drifting at run time.
      const todo = (await res.json()) as { title?: string };
      created.push(todo.title as string);
    }
    return { created };
  },
});
