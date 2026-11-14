import { defineStep } from "nukadoko";
import { z } from "zod";
import createTodo from "./create-todo.ts";

// The consumer half of the promoted pair: a claim step that reads the
// producer's validated result through `from` rather than a World bag
// write. No World, no stash: the dependency is visible twice now,
// statically as this file's own import of create-todo.ts and its `from`
// entry, and at run time as `used` on this step's step record. The claim
// compares the title the app returned when the todo was created with the
// title the sentence names, and its record labels each side with where it
// came from: the producer's step record and the line. The step has no
// `observe`, because a claim step reads an earlier step's result only
// through `from`, where the record names its origin.
export default defineStep({
  pattern: "the created todo is titled {title:string}",
  description: "The todo the previous step created has this title, as the app returned it",
  args: z.object({
    title: z.string().describe("The title the created todo is expected to have"),
    createdTitle: z.string().describe("The title of the todo the previous step created, as the app returned it"),
  }),
  from: { createdTitle: [createTodo, "title"] },
  claims: [{ actual: "createdTitle", compare: "equal", expected: "title" }],
});
