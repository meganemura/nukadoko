import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the todo list includes {title:string}",
  description: "Assert a todo with this title is present in GET /todos",
  rationale:
    "GET /todos, bound in Then position: read-only (mutates: false), and, unlike a step that only " +
    "answers a question, this one asserts. It throws when the title is absent, because a Then step " +
    "that always returns ok with no way to fail proves nothing. Returning `found` as well keeps the " +
    "record readable without opening the HTTP log.",
  args: z.object({ title: z.string().describe("The title expected to be present") }),
  returns: z.object({ found: z.boolean().describe("Always true when the step returns; absence throws") }),
  mutates: false,
  async run({ request }, args) {
    const res = await request.get("/todos");
    const todos = (await res.json()) as Array<{ title?: string }>;
    const found = todos.some((todo) => todo.title === args.title);
    if (!found) {
      throw new Error(`no todo titled "${args.title}" in GET /todos`);
    }
    return { found };
  },
});
