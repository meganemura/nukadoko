import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "a todo titled {title:string} is added",
  description: "Create a todo via POST /todos and return the created record",
  rationale:
    "The returns schema's key is `title`, the same word the pattern capture uses, so Part 2 of " +
    "README.md (self-healing) can fix exactly one line (the field name this call sends on the wire) " +
    "without touching this step's public contract or the feature file that calls it. A step that " +
    "wrapped the whole request body in its own shape would hide that one line.",
  args: z.object({ title: z.string().describe("The title of the todo to create") }),
  returns: z.object({
    id: z.string().describe("The id the server assigned"),
    title: z.string().describe("The title as the server stored it"),
    done: z.boolean().describe("Whether the todo is done; false for a new one"),
  }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.post("/todos", { data: { title: args.title } });
    return res.json();
  },
});
