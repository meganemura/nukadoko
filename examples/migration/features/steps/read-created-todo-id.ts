import { defineStep } from "nukadoko";
import { z } from "zod";
import createTodo from "./create-todo.js";

// The consumer half of the promoted pair: reads the producer's validated
// result through `ctx.resultOf` rather than a World bag write -- the same
// producer-then-consumer shape tests/fixtures/compat-mixed-project's own
// read-thing-via-resultof.ts fixture demonstrates. No World, no stash: the
// dependency is visible twice now, statically as this file's own import of
// create-todo.js and at run time as `used` on this step's receipt.
export default defineStep({
  pattern: "the created todo id is read back via resultOf",
  description: "Read the previous step's validated result through ctx.resultOf",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  mutates: false,
  run(ctx) {
    const created = ctx.resultOf(createTodo);
    if (!created) {
      throw new Error("expected a prior \"a todo titled ... is created\" result to read via resultOf");
    }
    return { id: created.id };
  },
});
