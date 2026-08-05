import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createThing from "./create-thing.js";

export default defineStep({
  pattern: "the created thing id is read via resultOf",
  description: "Read the earlier step's validated result through ctx.resultOf",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  run({ resultOf }) {
    const created = resultOf(createThing);
    if (created?.id !== "t1") {
      throw new Error(`expected resultOf to read id "t1", got ${JSON.stringify(created)}`);
    }
    return { ok: true };
  },
});
