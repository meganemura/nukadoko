import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the todo titled {title:string} is marked done",
  description: "Assert the todo with this title has done: true in GET /todos",
  rationale:
    "GET /todos in Then position, the same assert-don't-just-answer shape as todo-list-includes: " +
    "it throws when the todo is absent or not done, because a Then step that always returns ok " +
    "with no way to fail proves nothing. It checks `done` where todo-list-includes checks presence, " +
    "so a scenario can state either claim on its own line.",
  args: z.object({ title: z.string().describe("The title of the todo expected to be done") }),
  returns: z.object({ done: z.boolean().describe("Always true when the step returns; a false state throws") }),
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
