import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Three `ctx.section` calls, none doing any real work — the receipt's own
// `sections` array is the whole point of this step (t3-sections task spec,
// test bullet 1: "3 回呼んだ step の receipt に、その 3 つが呼んだ順で載る").
export default defineStep({
  pattern: "a step with three sections runs",
  description: "Calls ctx.section three times in order",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run(ctx) {
    ctx.section("one");
    ctx.section("two");
    ctx.section("three");
    return { ok: true };
  },
});
