import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the following todos are added",
  description: "POST /todos once per table row and return the titles created",
  rationale:
    "No named capture in this pattern, so the attached data table binds to the one required args " +
    "key left unconsumed: `todos`, one row per title, each row a single-cell string[] (docs/spec.md " +
    "\"Typed steps\": a table binds as string[][], no header-row convention). The row's title is cast, " +
    "not validated, on the way out: whether it is a string is exactly what the returns schema checks, " +
    "which is the point of README.md Part 2. TypeScript trusts the wire contract; zod catches it drifting.",
  args: z.object({
    todos: z
      .array(z.array(z.string()))
      .describe("The data table's rows, one todo per row, the title in the first cell"),
  }),
  returns: z.object({ created: z.array(z.string()).describe("The titles the server stored, in row order") }),
  mutates: true,
  async run({ request }, args) {
    const created: string[] = [];
    for (const row of args.todos) {
      const res = await request.post("/todos", { data: { title: row[0] } });
      const todo = (await res.json()) as { title?: string };
      created.push(todo.title as string);
    }
    return { created };
  },
});
