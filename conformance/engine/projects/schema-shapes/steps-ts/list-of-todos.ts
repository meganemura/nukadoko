import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "A list of todos, the last one done",
  pattern: "a list of {count:int} todos",
  args: z.object({ count: z.number().int().positive().describe("How many todos") }),
  returns: z.object({
    todos: z.array(z.object({ id: z.string().describe("The todo's id"), done: z.boolean().describe("Whether it is done") })).describe("The todos"),
  }),
  // Keeps nothing.
  mutates: false,
  run({}, { count }) {
    return { todos: Array.from({ length: count }, (_, i) => ({ id: `t${i + 1}`, done: i === count - 1 })) };
  },
});
