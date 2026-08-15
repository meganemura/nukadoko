import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

// Three `ctx.section` calls, none doing any real work — the step record's own
// `sections` array is the whole point of this step (t3-sections task spec,
// test bullet 1: a step that called section three times has its step record
// list the three in the order they were called).
export default defineStep({
  pattern: "a step with three sections runs",
  description: "Calls ctx.section three times in order",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ section }) {
    section("one");
    section("two");
    section("three");
    return { ok: true };
  },
});
