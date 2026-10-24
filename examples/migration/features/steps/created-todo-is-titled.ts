import { defineStep } from "nukadoko";
import { z } from "zod";
import createTodo from "./create-todo.ts";

// The consumer half of the promoted pair: a claim step that reads the
// producer's validated result through the `resultOf` fixture rather than a
// World bag write, the same producer-then-consumer shape
// tests/fixtures/compat-mixed-project's own read-thing-via-resultof.ts
// fixture demonstrates. No World, no stash: the dependency is visible twice
// now, statically as this file's own import of create-todo.ts and at run
// time as `used` on this step's step record. The title to compare with is
// in the sentence, and nukadoko judges the claim, so the step has no run.
export default defineStep({
  pattern: "the created todo is titled {title:string}",
  description: "The todo the previous step created, read through resultOf, has this title",
  args: z.object({ title: z.string().describe("The title the created todo is expected to have") }),
  observe({ resultOf }) {
    return { created: resultOf(createTodo) ?? null };
  },
  claims: [{ actual: "created.title", compare: "equal", expected: "title" }],
});
