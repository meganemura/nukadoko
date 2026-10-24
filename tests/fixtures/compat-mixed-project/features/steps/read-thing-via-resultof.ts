import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createThing from "./create-thing.js";

// observe reads the earlier step's validated result through ctx.resultOf,
// so the claim proves resultOf still works beside a compat step.
export default defineStep({
  pattern: "the created thing id is {id:string} via resultOf",
  description: "Read the earlier step's validated result through ctx.resultOf",
  args: z.object({ id: z.string() }),
  observe({ resultOf }) {
    return { created: resultOf(createThing)?.id ?? null };
  },
  claims: [{ actual: "created", compare: "equal", expected: "id" }],
});
