import { z } from "zod";
import { defineStep } from "nukadoko";
import thingExists from "./thing-exists.js";

// Bound in Then position in passing.feature: a claim step, so the name the
// sentence states is compared with the name the Given created, and the step
// has no run of its own.
export default defineStep({
  pattern: "the thing {name:string} exists",
  description: "Check that the thing the Given created has this name",
  args: z.object({ name: z.string(), created: z.string() }),
  from: { created: [thingExists, "name"] },
  claims: [{ actual: "created", compare: "equal", expected: "name" }],
});
