import { defineStep } from "nukadoko";
import { z } from "zod";

// POST /todos. The returns schema's key is "title" -- the same word this
// step's own pattern capture uses -- so Part 2 of README.md (self-healing)
// can fix exactly one line (the field name this call sends on the wire)
// without touching this step's public contract or the feature file that
// calls it.
export default defineStep({
  pattern: "a todo titled {title:string} is added",
  description: "Create a todo via POST /todos and return the created record",
  args: z.object({ title: z.string() }),
  returns: z.object({ id: z.string(), title: z.string(), done: z.boolean() }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.post("/todos", { data: { title: args.title } });
    return res.json();
  },
});
